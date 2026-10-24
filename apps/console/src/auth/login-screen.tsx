import { zodResolver } from '@hookform/resolvers/zod';
import {
  credentialsSchema,
  recoveryCodeSchema,
  totpCodeSchema,
  type Credentials,
  type RecoveryCode,
  type TotpCode,
} from '@elysium/contracts';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiError, endpoints, NetworkError, type LoginBranding } from '../api.js';
import { applyBrand } from '../brand.js';
import { Alert, Button, Field, Skeleton } from '../ui/primitives.js';
import { useT } from '../i18n/locale.js';

/**
 * The branded login (D-035, architecture §6, §24).
 *
 * One component owns the whole journey — credentials, the second factor,
 * recovery, and first-time enrolment — because they are one conversation with
 * the server and splitting them across routes would mean putting a half-signed
 * -in state somewhere a refresh could resume from. Nothing here is persisted:
 * the password lives in component state only for as long as enrolment needs it,
 * which is the one step Better Auth asks for it a second time.
 */

type Step = 'credentials' | 'totp' | 'recovery' | 'enrol' | 'walled';

/**
 * The set-up screens, in their own chunk (M40): only a person setting up two-step sign-in
 * opens them, and with the QR code they would not fit the first download's budget.
 */
const EnrolStep = lazy(() =>
  import('./enrol-step.js').then((module) => ({ default: module.EnrolStep })),
);
const WalledStep = lazy(() =>
  import('./enrol-step.js').then((module) => ({ default: module.WalledStep })),
);

export interface LoginScreenProps {
  readonly branding: LoginBranding | null;
  /** Called once the user is through every gate and may use the console. */
  readonly onAuthenticated: () => void | Promise<void>;
  /**
   * The session exists but is walled (M40, D-699): the brand's security setting now requires
   * two-step sign-in of this person's role. Opens on the set-up screen, asking only for the
   * password Better Auth's enrolment needs, rather than on a sign-in form they already passed.
   */
  readonly walled?: boolean;
}

export function LoginScreen({ branding, onAuthenticated, walled = false }: LoginScreenProps) {
  const t = useT();
  const [step, setStep] = useState<Step>(walled ? 'walled' : 'credentials');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const heading =
    step === 'enrol' || step === 'walled'
      ? t('auth.enrol.title')
      : step === 'credentials'
        ? t('auth.title')
        : t('auth.twoFactor.title');

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <BrandMark branding={branding} />

        <div className="mt-8 rounded-xl border border-border bg-card p-7 shadow-popover">
          <h1 className="text-lg font-semibold tracking-tight text-card-foreground">{heading}</h1>

          {step === 'credentials' ? (
            <CredentialsStep
              error={error}
              onError={setError}
              onSignedIn={async (values, needsSecondFactor) => {
                setPassword(values.password);
                setError(null);
                if (needsSecondFactor) {
                  setStep('totp');
                  return;
                }
                await finish(onAuthenticated, setStep, setError, t);
              }}
            />
          ) : null}

          {step === 'totp' || step === 'recovery' ? (
            <SecondFactorStep
              mode={step}
              error={error}
              onError={setError}
              onSwitchMode={(next) => {
                setError(null);
                setStep(next);
              }}
              onVerified={() => finish(onAuthenticated, setStep, setError, t)}
            />
          ) : null}

          {step === 'walled' || step === 'enrol' ? (
            <Suspense fallback={<EnrolFallback />}>
              {step === 'walled' ? (
                <WalledStep
                  onPassword={(value) => {
                    setPassword(value);
                    setError(null);
                    setStep('enrol');
                  }}
                />
              ) : (
                <EnrolStep
                  password={password}
                  brandSlug={branding?.slug ?? null}
                  error={error}
                  onError={setError}
                  onEnrolled={() => finish(onAuthenticated, setStep, setError, t)}
                />
              )}
            </Suspense>
          ) : null}
        </div>

        {/* The brand's own legal name, from its row; nothing at all when no brand is known. */}
        {typeof branding?.brand?.legalName === 'string' ? (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            {branding.brand.legalName}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Finish the journey, or discover that the enrolment wall is in the way.
 *
 * The wall is only visible on a real request, so this probes one rather than
 * guessing from the user's roles — which the client does not know and must not
 * be trusted with anyway.
 */
async function finish(
  onAuthenticated: () => void | Promise<void>,
  setStep: (step: Step) => void,
  setError: (message: string | null) => void,
  t: ReturnType<typeof useT>,
): Promise<void> {
  try {
    await endpoints.myOrgs();
    await onAuthenticated();
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'TWO_FACTOR_ENROLMENT_REQUIRED') {
      setError(null);
      setStep('enrol');
      return;
    }
    setError(messageFor(cause, t('auth.failed'), t));
  }
}

/**
 * Say what actually went wrong.
 *
 * Everything used to collapse into "that email and password do not match",
 * which is the most damaging thing to say when it is untrue: a rate-limited or
 * CSRF-rejected user goes and resets a password that was never wrong. Only 401
 * and 400 are actually about the credentials.
 */
export function messageFor(cause: unknown, fallback: string, t: ReturnType<typeof useT>): string {
  if (cause instanceof NetworkError) return t('auth.unreachable');

  if (cause instanceof ApiError) {
    if (cause.status === 429) return t('auth.tooMany');
    // The password was right and the account may not be used: a deactivated leaver,
    // or someone with no role left anywhere (D-401). Saying so stops a reset hunt.
    if (cause.code === 'ACCOUNT_INACTIVE') return t('auth.inactive');
    // 403 here is the CSRF or origin check, not a permission decision — the
    // user has not been identified yet, so there is nothing to forbid.
    if (cause.status === 403 && cause.code !== 'TWO_FACTOR_ENROLMENT_REQUIRED') {
      return t('auth.rejected');
    }
  }

  return fallback;
}

export function BrandMark({ branding }: { readonly branding: LoginBranding | null }) {
  const t = useT();
  // The brand's own name from its row (D-472); a neutral word when none is known.
  const name = branding?.displayName ?? t('workspace.title');
  const logo = typeof branding?.brand?.logo === 'string' ? branding.brand.logo : null;

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {logo === null ? (
        <div
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground"
        >
          {name.slice(0, 1).toUpperCase()}
        </div>
      ) : (
        <img src={logo} alt="" className="h-10 w-auto" />
      )}
      <div>
        <p className="text-sm font-semibold tracking-tight text-foreground">{name}</p>
        <p className="text-xs text-muted-foreground">{t('auth.subtitle')}</p>
      </div>
    </div>
  );
}

function CredentialsStep({
  error,
  onError,
  onSignedIn,
}: {
  readonly error: string | null;
  readonly onError: (message: string | null) => void;
  readonly onSignedIn: (values: Credentials, needsSecondFactor: boolean) => Promise<void>;
}) {
  const t = useT();
  const form = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: '', password: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    onError(null);
    try {
      const result = await endpoints.signIn(values.email, values.password);
      await onSignedIn(values, result.twoFactorRedirect === true);
    } catch (cause) {
      onError(messageFor(cause, t('auth.failed'), t));
    }
  });

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4" noValidate>
      <Field
        label={t('auth.email')}
        type="email"
        autoComplete="username"
        placeholder={t('auth.email.placeholder')}
        autoFocus
        {...form.register('email')}
        error={form.formState.errors.email === undefined ? undefined : t('auth.failed')}
      />
      <Field
        label={t('auth.password')}
        type="password"
        autoComplete="current-password"
        {...form.register('password')}
      />

      {error === null ? null : <Alert>{error}</Alert>}

      <Button type="submit" busy={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
      </Button>
    </form>
  );
}

function SecondFactorStep({
  mode,
  error,
  onError,
  onSwitchMode,
  onVerified,
}: {
  readonly mode: 'totp' | 'recovery';
  readonly error: string | null;
  readonly onError: (message: string | null) => void;
  readonly onSwitchMode: (next: 'totp' | 'recovery') => void;
  readonly onVerified: () => Promise<void>;
}) {
  const t = useT();
  const isTotp = mode === 'totp';
  // The two codes have different shapes, and saying so beats letting a pasted
  // recovery code fail verification as though it were a wrong TOTP.
  const form = useForm<TotpCode | RecoveryCode>({
    resolver: zodResolver(isTotp ? totpCodeSchema : recoveryCodeSchema),
    defaultValues: { code: '' },
  });

  const submit = form.handleSubmit(async ({ code }) => {
    onError(null);
    try {
      if (isTotp) await endpoints.verifyTotp(code);
      else await endpoints.verifyBackupCode(code);
      await onVerified();
    } catch (cause) {
      onError(
        messageFor(
          cause,
          isTotp ? t('auth.twoFactor.invalid') : t('auth.twoFactor.recoveryInvalid'),
          t,
        ),
      );
    }
  });

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">
        {isTotp ? t('auth.twoFactor.subtitle') : t('auth.twoFactor.recoveryHint')}
      </p>

      <Field
        label={isTotp ? t('auth.twoFactor.code') : t('auth.twoFactor.recoveryCode')}
        error={
          form.formState.errors.code === undefined
            ? undefined
            : isTotp
              ? t('auth.twoFactor.invalid')
              : t('auth.twoFactor.recoveryInvalid')
        }
        // A one-time code is not a password: `one-time-code` is what lets a
        // phone offer the SMS or authenticator value straight from the keyboard.
        autoComplete={isTotp ? 'one-time-code' : 'off'}
        inputMode={isTotp ? 'numeric' : 'text'}
        autoFocus
        className={isTotp ? 'text-center font-mono text-base tracking-[0.3em] tabular-nums' : ''}
        {...form.register('code')}
      />

      {error === null ? null : <Alert>{error}</Alert>}

      <Button type="submit" busy={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t('auth.twoFactor.verifying') : t('auth.twoFactor.verify')}
      </Button>

      <div className="text-center">
        <Button variant="link" onClick={() => onSwitchMode(isTotp ? 'recovery' : 'totp')}>
          {isTotp ? t('auth.twoFactor.useRecovery') : t('auth.twoFactor.useApp')}
        </Button>
      </div>
    </form>
  );
}

/** The set-up screen's shape while its chunk arrives. */
function EnrolFallback() {
  const t = useT();
  return (
    <div className="mt-5 space-y-4" aria-busy="true">
      <span className="sr-only">{t('common.loading')}</span>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/** Re-applies the brand whenever the resolved org changes. */
export function useBrand(branding: LoginBranding | null): void {
  useEffect(() => {
    applyBrand(branding);
  }, [branding]);
}
