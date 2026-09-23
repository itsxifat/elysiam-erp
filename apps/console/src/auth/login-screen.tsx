import { zodResolver } from '@hookform/resolvers/zod';
import {
  credentialsSchema,
  recoveryCodeSchema,
  totpCodeSchema,
  type Credentials,
  type RecoveryCode,
  type TotpCode,
} from '@elysium/contracts';
import { t } from '@elysium/i18n';
import { Check, Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';

import {
  ApiError,
  endpoints,
  NetworkError,
  type EnrolmentResult,
  type LoginBranding,
} from '../api.js';
import { applyBrand } from '../brand.js';
import { Alert, Button, Field, Skeleton } from '../ui/primitives.js';

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

type Step = 'credentials' | 'totp' | 'recovery' | 'enrol';

export interface LoginScreenProps {
  readonly branding: LoginBranding | null;
  /** Called once the user is through every gate and may use the console. */
  readonly onAuthenticated: () => void | Promise<void>;
}

export function LoginScreen({ branding, onAuthenticated }: LoginScreenProps) {
  const [step, setStep] = useState<Step>('credentials');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const heading =
    step === 'enrol'
      ? t('auth.enrol.title')
      : step === 'credentials'
        ? t('auth.title')
        : t('auth.twoFactor.title');

  return (
    <div className="grid min-h-dvh place-items-center bg-muted px-4 py-10">
      <div className="w-full max-w-sm">
        <BrandMark branding={branding} />

        <div className="mt-6 rounded-lg border border-border bg-card p-6 shadow-popover">
          <h1 className="text-base font-semibold tracking-tight text-card-foreground">{heading}</h1>

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
                await finish(onAuthenticated, setStep, setError);
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
              onVerified={() => finish(onAuthenticated, setStep, setError)}
            />
          ) : null}

          {step === 'enrol' ? (
            <EnrolStep
              password={password}
              error={error}
              onError={setError}
              onEnrolled={() => finish(onAuthenticated, setStep, setError)}
            />
          ) : null}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {branding?.brand?.legalName ?? 'Elysium'}
        </p>
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
    setError(messageFor(cause, t('auth.failed')));
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
function messageFor(cause: unknown, fallback: string): string {
  if (cause instanceof NetworkError) return t('auth.unreachable');

  if (cause instanceof ApiError) {
    if (cause.status === 429) return t('auth.tooMany');
    // 403 here is the CSRF or origin check, not a permission decision — the
    // user has not been identified yet, so there is nothing to forbid.
    if (cause.status === 403 && cause.code !== 'TWO_FACTOR_ENROLMENT_REQUIRED') {
      return t('auth.rejected');
    }
  }

  return fallback;
}

function BrandMark({ branding }: { readonly branding: LoginBranding | null }) {
  const name = branding?.displayName ?? 'Elysium';
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
      onError(messageFor(cause, t('auth.failed')));
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

/**
 * First-time enrolment, for a role §6 requires a second factor from.
 *
 * This screen is why the server issues a session before the factor exists: the
 * enrolment endpoints need one. Everything else stays walled until the code
 * below verifies.
 */
function EnrolStep({
  password,
  error,
  onError,
  onEnrolled,
}: {
  readonly password: string;
  readonly error: string | null;
  readonly onError: (message: string | null) => void;
  readonly onEnrolled: () => Promise<void>;
}) {
  const [enrolment, setEnrolment] = useState<EnrolmentResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const form = useForm<TotpCode>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: '' },
  });

  useEffect(() => {
    let cancelled = false;
    endpoints
      .enrol(password)
      .then((result) => {
        if (!cancelled) setEnrolment(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) onError(messageFor(cause, t('auth.enrol.failed')));
      });
    return () => {
      cancelled = true;
    };
  }, [password, onError]);

  const submit = form.handleSubmit(async ({ code }) => {
    onError(null);
    try {
      await endpoints.verifyTotp(code);
      await onEnrolled();
    } catch (cause) {
      onError(messageFor(cause, t('auth.twoFactor.invalid')));
    }
  });

  if (enrolment === null) {
    return (
      <div className="mt-5 space-y-5">
        <p className="text-sm text-muted-foreground">{t('auth.enrol.subtitle')}</p>
        {error === null ? (
          <div className="space-y-4" aria-busy="true" aria-label={t('common.loading')}>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <Alert>{error}</Alert>
        )}
      </div>
    );
  }

  const secret = secretFrom(enrolment.totpURI);

  return (
    <div className="mt-5 space-y-5">
      <p className="text-sm text-muted-foreground">{t('auth.enrol.subtitle')}</p>

      <Step icon={<KeyRound className="size-4" aria-hidden="true" />} label={t('auth.enrol.step1')}>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {secret}
          </code>
          <Button
            variant="ghost"
            aria-label={t('auth.enrol.copy')}
            onClick={() => {
              void navigator.clipboard.writeText(secret).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            <span className="sr-only">
              {copied ? t('auth.enrol.copied') : t('auth.enrol.copy')}
            </span>
          </Button>
        </div>
      </Step>

      <Step
        icon={<ShieldCheck className="size-4" aria-hidden="true" />}
        label={t('auth.enrol.step2')}
      >
        <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-muted p-3 font-mono text-xs text-foreground">
          {enrolment.backupCodes.map((code) => (
            <li key={code} className="tabular-nums">
              {code}
            </li>
          ))}
        </ul>
        {/* Stacked, not side by side: at the card's width the two controls
            collided and the checkbox label wrapped across the button. */}
        <div className="mt-3 space-y-3">
          <Button variant="link" onClick={() => downloadCodes(enrolment.backupCodes)}>
            <Download className="size-4" aria-hidden="true" />
            {t('auth.enrol.download')}
          </Button>
          <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-px size-4 shrink-0 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            <span>{t('auth.enrol.acknowledge')}</span>
          </label>
        </div>
      </Step>

      <form onSubmit={(event) => void submit(event)} className="space-y-3" noValidate>
        <Field
          label={t('auth.twoFactor.code')}
          hint={t('auth.enrol.step3')}
          error={form.formState.errors.code === undefined ? undefined : t('auth.twoFactor.invalid')}
          autoComplete="one-time-code"
          inputMode="numeric"
          className="text-center font-mono text-base tracking-[0.3em] tabular-nums"
          {...form.register('code')}
        />

        {error === null ? null : <Alert>{error}</Alert>}

        <Button type="submit" busy={form.formState.isSubmitting} disabled={!acknowledged}>
          {t('auth.enrol.confirm')}
        </Button>
      </form>
    </div>
  );
}

function Step({
  icon,
  label,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </h2>
      {children}
    </section>
  );
}

/** The base32 secret an authenticator app expects, out of the otpauth URI. */
function secretFrom(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

function downloadCodes(codes: readonly string[]): void {
  const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'elysium-recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}

/** Re-applies the brand whenever the resolved org changes. */
export function useBrand(branding: LoginBranding | null): void {
  useEffect(() => {
    applyBrand(branding);
  }, [branding]);
}
