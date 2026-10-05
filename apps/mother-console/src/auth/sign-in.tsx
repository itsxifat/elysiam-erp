import { Button, Skeleton } from '@elysium/ui';
import { Check, Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

import { ApiError, endpoints, NetworkError, type EnrolmentResult } from '../api.js';
import { useT, type MessageKey } from '../i18n/locale.js';
import { Alert, Field } from '../ui/primitives.js';

/**
 * Signing in to the owner console (D-487): the password, then the code from the
 * authenticator app (or a recovery code), and — for an owner who has none yet — setting
 * the app up first. Every owner has a second factor; the server walls everything else
 * until there is one.
 */

type Step = 'credentials' | 'totp' | 'recovery' | 'enrol';

function messageFor(cause: unknown, fallback: MessageKey): MessageKey {
  if (cause instanceof NetworkError) return 'auth.unreachable';
  if (cause instanceof ApiError) {
    if (cause.status === 429) return 'auth.tooMany';
    if (cause.code === 'ACCOUNT_INACTIVE') return 'auth.inactive';
    if (cause.status === 403 && cause.code !== 'TWO_FACTOR_ENROLMENT_REQUIRED') {
      return 'auth.rejected';
    }
  }
  return fallback;
}

export function SignInScreen({
  initialStep = 'credentials',
  onSignedIn,
}: {
  readonly initialStep?: Step;
  readonly onSignedIn: () => Promise<void>;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>(initialStep);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);

  async function finish(): Promise<void> {
    try {
      await endpoints.me();
      await onSignedIn();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'TWO_FACTOR_ENROLMENT_REQUIRED') {
        setError(null);
        setStep('enrol');
        return;
      }
      setError(messageFor(cause, 'auth.failed'));
    }
  }

  const heading: MessageKey =
    step === 'credentials'
      ? 'auth.title'
      : step === 'enrol'
        ? 'auth.enrol.title'
        : 'auth.twoFactor.title';

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            aria-hidden="true"
            className="grid size-10 place-items-center rounded-md bg-primary text-primary-foreground"
          >
            <KeyRound className="size-5" />
          </div>
          <p className="text-sm font-semibold tracking-tight text-foreground">{t('app.name')}</p>
        </div>
        <div className="mt-8 rounded-xl border border-border bg-card p-7 shadow-popover">
          <h1 className="text-lg font-semibold tracking-tight text-card-foreground">
            {t(heading)}
          </h1>
          {step === 'credentials' ? (
            <Credentials
              error={error}
              onError={setError}
              onDone={async (typed, needsCode) => {
                setPassword(typed);
                setError(null);
                if (needsCode) setStep('totp');
                else await finish();
              }}
            />
          ) : null}
          {step === 'totp' || step === 'recovery' ? (
            <SecondFactor
              mode={step}
              error={error}
              onError={setError}
              onSwitch={(next) => {
                setError(null);
                setStep(next);
              }}
              onDone={finish}
            />
          ) : null}
          {step === 'enrol' ? (
            <Enrol password={password} error={error} onError={setError} onDone={finish} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Credentials({
  error,
  onError,
  onDone,
}: {
  readonly error: MessageKey | null;
  readonly onError: (key: MessageKey | null) => void;
  readonly onDone: (password: string, needsCode: boolean) => Promise<void>;
}) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onError(null);
    setBusy(true);
    try {
      const result = await endpoints.signIn(email.trim(), password);
      await onDone(password, result.twoFactorRedirect === true);
    } catch (cause) {
      onError(messageFor(cause, 'auth.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4" noValidate>
      <Field
        label={t('auth.email')}
        type="email"
        autoComplete="username"
        autoFocus
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <Field
        label={t('auth.password')}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error === null ? null : <Alert>{t(error)}</Alert>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? t('auth.signingIn') : t('auth.signIn')}
      </Button>
    </form>
  );
}

function SecondFactor({
  mode,
  error,
  onError,
  onSwitch,
  onDone,
}: {
  readonly mode: 'totp' | 'recovery';
  readonly error: MessageKey | null;
  readonly onError: (key: MessageKey | null) => void;
  readonly onSwitch: (next: 'totp' | 'recovery') => void;
  readonly onDone: () => Promise<void>;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const isTotp = mode === 'totp';

  async function submit(event: FormEvent) {
    event.preventDefault();
    onError(null);
    setBusy(true);
    try {
      if (isTotp) await endpoints.verifyTotp(code.replace(/\s/g, ''));
      else await endpoints.verifyBackupCode(code.trim());
      await onDone();
    } catch (cause) {
      onError(
        messageFor(cause, isTotp ? 'auth.twoFactor.invalid' : 'auth.twoFactor.recoveryInvalid'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">
        {isTotp ? t('auth.twoFactor.subtitle') : t('auth.twoFactor.recoveryHint')}
      </p>
      <Field
        label={isTotp ? t('auth.twoFactor.code') : t('auth.twoFactor.recoveryCode')}
        autoComplete={isTotp ? 'one-time-code' : 'off'}
        inputMode={isTotp ? 'numeric' : 'text'}
        autoFocus
        value={code}
        onChange={(event) => setCode(event.target.value)}
        className={isTotp ? 'text-center font-mono text-base tracking-[0.3em] tabular-nums' : ''}
      />
      {error === null ? null : <Alert>{t(error)}</Alert>}
      <Button type="submit" className="w-full" disabled={busy || code.trim() === ''}>
        {busy ? t('auth.twoFactor.verifying') : t('auth.twoFactor.verify')}
      </Button>
      <div className="text-center">
        <Button variant="link" onClick={() => onSwitch(isTotp ? 'recovery' : 'totp')}>
          {isTotp ? t('auth.twoFactor.useRecovery') : t('auth.twoFactor.useApp')}
        </Button>
      </div>
    </form>
  );
}

function secretFrom(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

function Enrol({
  password: known,
  error,
  onError,
  onDone,
}: {
  readonly password: string;
  readonly error: MessageKey | null;
  readonly onError: (key: MessageKey | null) => void;
  readonly onDone: () => Promise<void>;
}) {
  const t = useT();
  const [password, setPassword] = useState(known);
  const [enrolment, setEnrolment] = useState<EnrolmentResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function start(event?: FormEvent) {
    event?.preventDefault();
    onError(null);
    setStarting(true);
    try {
      setEnrolment(await endpoints.enrol(password));
    } catch (cause) {
      onError(messageFor(cause, 'auth.enrol.failed'));
    } finally {
      setStarting(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    onError(null);
    setBusy(true);
    try {
      await endpoints.verifyTotp(code.replace(/\s/g, ''));
      await onDone();
    } catch (cause) {
      onError(messageFor(cause, 'auth.twoFactor.invalid'));
    } finally {
      setBusy(false);
    }
  }

  if (enrolment === null) {
    return (
      <form onSubmit={(event) => void start(event)} className="mt-5 space-y-4" noValidate>
        <p className="text-sm text-muted-foreground">{t('auth.enrol.subtitle')}</p>
        <Field
          label={t('auth.enrol.password')}
          type="password"
          autoComplete="current-password"
          autoFocus={known === ''}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error === null ? null : <Alert>{t(error)}</Alert>}
        {starting ? <Skeleton className="h-9 w-full" /> : null}
        <Button type="submit" className="w-full" disabled={starting || password === ''}>
          {t('auth.enrol.start')}
        </Button>
      </form>
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
            size="icon-sm"
            aria-label={copied ? t('common.copied') : t('common.copy')}
            onClick={() => {
              void navigator.clipboard.writeText(secret).then(() => setCopied(true));
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </div>
      </Step>
      <Step
        icon={<ShieldCheck className="size-4" aria-hidden="true" />}
        label={t('auth.enrol.step2')}
      >
        <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-muted p-3 font-mono text-xs text-foreground">
          {enrolment.backupCodes.map((backup) => (
            <li key={backup} className="tabular-nums">
              {backup}
            </li>
          ))}
        </ul>
        <div className="mt-3 space-y-3">
          <Button variant="link" onClick={() => downloadCodes(enrolment.backupCodes)}>
            <Download aria-hidden="true" />
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
      <form onSubmit={(event) => void confirm(event)} className="space-y-3" noValidate>
        <Field
          label={t('auth.twoFactor.code')}
          hint={t('auth.enrol.step3')}
          autoComplete="one-time-code"
          inputMode="numeric"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className="text-center font-mono text-base tracking-[0.3em] tabular-nums"
        />
        {error === null ? null : <Alert>{t(error)}</Alert>}
        <Button
          type="submit"
          className="w-full"
          disabled={busy || !acknowledged || code.trim() === ''}
        >
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

function downloadCodes(codes: readonly string[]): void {
  const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}
