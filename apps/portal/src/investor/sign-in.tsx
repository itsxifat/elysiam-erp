import { zodResolver } from '@hookform/resolvers/zod';
import {
  credentialsSchema,
  recoveryCodeSchema,
  totpCodeSchema,
  type Credentials,
  type RecoveryCode,
  type TotpCode,
} from '@elysium/contracts';
import { Button, Checkbox, Skeleton } from '@elysium/ui';
import { Check, Copy, Download, KeyRound, Landmark, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';

import { ApiError, NetworkError } from '../http.js';
import { auth, type EnrolmentResult } from './api.js';
import type { Translate } from './messages.js';
import { Alert, Field, FOCUS, SubmitButton } from './ui.js';

/**
 * The investor's sign-in (M25; §6, §15: "2FA is mandatory").
 *
 * The console's journey (M02a) against the same Better Auth endpoints: credentials, then
 * the second factor or a recovery code, and — for an investor who has never set one up —
 * enrolment. The server is what makes the second factor mandatory: the `investor` role is
 * behind §6's enrolment wall, so until a factor verifies, every route outside `/api/auth`
 * answers `403 TWO_FACTOR_ENROLMENT_REQUIRED` and the portal has nothing it could show. This
 * screen only makes that wall passable.
 *
 * One component owns the whole journey, so no half-signed-in state is ever somewhere a
 * refresh could resume from. The password stays in component state only for as long as
 * enrolment needs it, the one step Better Auth asks for it a second time.
 */

type Step = 'credentials' | 'totp' | 'recovery' | 'enrol';

export function SignIn({
  t,
  onAuthenticated,
}: {
  readonly t: Translate;
  /** Called once every gate is passed. */
  readonly onAuthenticated: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>('credentials');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * Finish, or discover that the enrolment wall is in the way. The wall shows only on a
   * real request, so this probes one rather than guessing from roles the client does not
   * know and must not be trusted with.
   */
  async function finish(): Promise<void> {
    try {
      await auth.myOrgs();
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

  const heading =
    step === 'enrol'
      ? t('auth.enrol.title')
      : step === 'credentials'
        ? t('auth.title')
        : t('auth.twoFactor.title');

  return (
    <div className="grid min-h-[calc(100dvh-3.5rem)] place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground"
          >
            <Landmark className="size-5" />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-semibold tracking-tight">{t('portal.investor.title')}</p>
            <p className="text-xs text-muted-foreground">{t('portal.investor.subtitle')}</p>
          </div>
        </div>

        {/* A card on the canvas: a hairline, no shadow (D-459). */}
        <div className="mt-8 rounded-xl border border-border bg-card p-7 text-card-foreground">
          <h1 className="text-lg font-semibold tracking-tight">{heading}</h1>

          {step === 'credentials' ? (
            <CredentialsStep
              t={t}
              error={error}
              onError={setError}
              onSignedIn={async (values, needsSecondFactor) => {
                setPassword(values.password);
                setError(null);
                if (needsSecondFactor) setStep('totp');
                else await finish();
              }}
            />
          ) : null}

          {step === 'totp' || step === 'recovery' ? (
            <SecondFactorStep
              t={t}
              mode={step}
              error={error}
              onError={setError}
              onSwitchMode={(next) => {
                setError(null);
                setStep(next);
              }}
              onVerified={finish}
            />
          ) : null}

          {step === 'enrol' ? (
            <EnrolStep
              t={t}
              password={password}
              error={error}
              onError={setError}
              onEnrolled={finish}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Say what actually went wrong. Only a 400 or 401 is about the credentials; telling a
 * rate-limited or CSRF-refused person their password is wrong sends them to reset one that
 * was never wrong.
 */
export function messageFor(cause: unknown, fallback: string, t: Translate): string {
  if (cause instanceof NetworkError) return t('auth.unreachable');
  if (cause instanceof ApiError) {
    if (cause.status === 429) return t('auth.tooMany');
    if (cause.status === 403 && cause.code !== 'TWO_FACTOR_ENROLMENT_REQUIRED') {
      return t('auth.rejected');
    }
  }
  return fallback;
}

function CredentialsStep({
  t,
  error,
  onError,
  onSignedIn,
}: {
  readonly t: Translate;
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
      const result = await auth.signIn(values.email, values.password);
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
        error={form.formState.errors.email === undefined ? undefined : t('auth.failed')}
        {...form.register('email')}
      />
      <Field
        label={t('auth.password')}
        type="password"
        autoComplete="current-password"
        {...form.register('password')}
      />
      {error === null ? null : <Alert>{error}</Alert>}
      <SubmitButton busy={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
      </SubmitButton>
    </form>
  );
}

function SecondFactorStep({
  t,
  mode,
  error,
  onError,
  onSwitchMode,
  onVerified,
}: {
  readonly t: Translate;
  readonly mode: 'totp' | 'recovery';
  readonly error: string | null;
  readonly onError: (message: string | null) => void;
  readonly onSwitchMode: (next: 'totp' | 'recovery') => void;
  readonly onVerified: () => Promise<void>;
}) {
  const isTotp = mode === 'totp';
  const form = useForm<TotpCode | RecoveryCode>({
    resolver: zodResolver(isTotp ? totpCodeSchema : recoveryCodeSchema),
    defaultValues: { code: '' },
  });
  const invalid = isTotp ? t('auth.twoFactor.invalid') : t('auth.twoFactor.recoveryInvalid');

  const submit = form.handleSubmit(async ({ code }) => {
    onError(null);
    try {
      if (isTotp) await auth.verifyTotp(code);
      else await auth.verifyBackupCode(code);
      await onVerified();
    } catch (cause) {
      onError(messageFor(cause, invalid, t));
    }
  });

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">
        {isTotp ? t('auth.twoFactor.subtitle') : t('auth.twoFactor.recoveryHint')}
      </p>
      <Field
        key={mode}
        label={isTotp ? t('auth.twoFactor.code') : t('auth.twoFactor.recoveryCode')}
        error={form.formState.errors.code === undefined ? undefined : invalid}
        autoComplete={isTotp ? 'one-time-code' : 'off'}
        inputMode={isTotp ? 'numeric' : 'text'}
        autoFocus
        className={isTotp ? 'text-center font-mono tracking-[0.3em] tabular-nums' : ''}
        {...form.register('code')}
      />
      {error === null ? null : <Alert>{error}</Alert>}
      <SubmitButton busy={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t('auth.twoFactor.verifying') : t('auth.twoFactor.verify')}
      </SubmitButton>
      <div className="text-center">
        <button
          type="button"
          onClick={() => onSwitchMode(isTotp ? 'recovery' : 'totp')}
          className={`rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline ${FOCUS}`}
        >
          {isTotp ? t('auth.twoFactor.useRecovery') : t('auth.twoFactor.useApp')}
        </button>
      </div>
    </form>
  );
}

/**
 * First-time enrolment. This screen is why the server issues a session before the factor
 * exists: the enrolment endpoints need one, and everything else stays walled until the code
 * below verifies.
 */
function EnrolStep({
  t,
  password,
  error,
  onError,
  onEnrolled,
}: {
  readonly t: Translate;
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

  /*
   * One enrolment per screen. Each call to the enable endpoint issues a new secret and
   * replaces the last, and React runs this effect twice in a development build — the
   * console's M05 stack run found the two requests racing, with the screen showing one
   * secret and the server keeping the other. The ref survives the double run.
   */
  const pending = useRef<{ password: string; result: Promise<EnrolmentResult> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (pending.current?.password !== password) {
      pending.current = { password, result: auth.enrol(password) };
    }
    pending.current.result
      .then((result) => {
        if (!cancelled) setEnrolment(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) onError(messageFor(cause, t('auth.enrol.failed'), t));
      });
    return () => {
      cancelled = true;
    };
  }, [password, onError, t]);

  const submit = form.handleSubmit(async ({ code }) => {
    onError(null);
    try {
      await auth.verifyTotp(code);
      await onEnrolled();
    } catch (cause) {
      onError(messageFor(cause, t('auth.twoFactor.invalid'), t));
    }
  });

  if (enrolment === null) {
    return (
      <div className="mt-5 space-y-5">
        <p className="text-sm text-muted-foreground">{t('portal.investor.enrolSubtitle')}</p>
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
      <p className="text-sm text-muted-foreground">{t('portal.investor.enrolSubtitle')}</p>

      <EnrolPart icon={<KeyRound aria-hidden="true" />} label={t('auth.enrol.step1')}>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {secret}
          </code>
          <Button
            variant="ghost"
            size="icon"
            aria-label={copied ? t('auth.enrol.copied') : t('auth.enrol.copy')}
            onClick={() => {
              void navigator.clipboard.writeText(secret).then(() => setCopied(true));
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </div>
      </EnrolPart>

      <EnrolPart icon={<ShieldCheck aria-hidden="true" />} label={t('auth.enrol.step2')}>
        <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-muted p-3 font-mono text-xs text-foreground">
          {enrolment.backupCodes.map((code) => (
            <li key={code} className="tabular-nums">
              {code}
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-3">
          <Button variant="outline" size="sm" onClick={() => downloadCodes(enrolment.backupCodes)}>
            <Download aria-hidden="true" />
            {t('auth.enrol.download')}
          </Button>
          <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={acknowledged}
              onCheckedChange={(state) => setAcknowledged(state === true)}
              className="mt-px"
            />
            <span>{t('auth.enrol.acknowledge')}</span>
          </label>
        </div>
      </EnrolPart>

      <form onSubmit={(event) => void submit(event)} className="space-y-3" noValidate>
        <Field
          label={t('auth.twoFactor.code')}
          hint={t('auth.enrol.step3')}
          error={form.formState.errors.code === undefined ? undefined : t('auth.twoFactor.invalid')}
          autoComplete="one-time-code"
          inputMode="numeric"
          className="text-center font-mono tracking-[0.3em] tabular-nums"
          {...form.register('code')}
        />
        {error === null ? null : <Alert>{error}</Alert>}
        <SubmitButton busy={form.formState.isSubmitting} disabled={!acknowledged}>
          {t('auth.enrol.confirm')}
        </SubmitButton>
      </form>
    </div>
  );
}

function EnrolPart({
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
      <h2 className="flex items-start gap-2 text-sm font-medium text-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
        {icon}
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
