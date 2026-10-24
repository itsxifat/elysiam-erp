import { zodResolver } from '@hookform/resolvers/zod';
import { totpCodeSchema, type TotpCode } from '@elysium/contracts';
import { Check, Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';

import { endpoints, type EnrolmentResult } from '../api.js';
import { useT } from '../i18n/locale.js';
import { Alert, Button, Field, Skeleton } from '../ui/primitives.js';
import { messageFor } from './login-screen.js';

/**
 * Setting up two-step sign-in at sign-in (§6; M40): the first-time enrolment a role requires,
 * and the way in for a session the brand's security setting has just walled. Its own chunk,
 * loaded only when one of them is shown, with the QR code's encoder behind it.
 */

/** The QR code's encoder, loaded only when the set-up screen shows one (M40). */
const TotpQr = lazy(() => import('./totp-qr.js'));

/**
 * A walled session's way in (M40): the password again, which Better Auth's enrolment needs,
 * and then the set-up. Signing out instead is offered too — it may not be the person's device.
 */
export function WalledStep({ onPassword }: { readonly onPassword: (password: string) => void }) {
  const t = useT();
  const [value, setValue] = useState('');
  return (
    <form
      className="mt-5 space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== '') onPassword(value);
      }}
    >
      <p className="text-sm text-muted-foreground">{t('auth.walled.detail')}</p>
      <Field
        label={t('auth.password')}
        type="password"
        autoComplete="current-password"
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" disabled={value === ''}>
        {t('auth.walled.continue')}
      </Button>
      <div className="text-center">
        <Button
          variant="link"
          onClick={() => {
            void endpoints.signOut().finally(() => window.location.reload());
          }}
        >
          {t('auth.signOut')}
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
export function EnrolStep({
  password,
  brandSlug,
  error,
  onError,
  onEnrolled,
}: {
  readonly password: string;
  /** Names the downloaded recovery codes after the brand (D-472). */
  readonly brandSlug: string | null;
  readonly error: string | null;
  readonly onError: (message: string | null) => void;
  readonly onEnrolled: () => Promise<void>;
}) {
  const t = useT();
  const [enrolment, setEnrolment] = useState<EnrolmentResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const form = useForm<TotpCode>({
    resolver: zodResolver(totpCodeSchema),
    defaultValues: { code: '' },
  });

  /*
   * One enrolment per screen, whatever the effect does.
   *
   * Each call to the enable endpoint issues a new secret and replaces the last one.
   * React runs this effect twice in a development build, so two requests raced:
   * the screen showed the secret of whichever answer it kept, the server kept the
   * secret of whichever write landed last, and a correct code from the app was
   * refused when the two differed. Found by the M05 stack spec on 2026-09-30. The
   * ref survives the double run, so both runs share the one request.
   */
  const request = useRef<{ password: string; result: Promise<EnrolmentResult> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (request.current?.password !== password) {
      request.current = { password, result: endpoints.enrol(password) };
    }
    request.current.result
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
      await endpoints.verifyTotp(code);
      await onEnrolled();
    } catch (cause) {
      onError(messageFor(cause, t('auth.twoFactor.invalid'), t));
    }
  });

  if (enrolment === null) {
    return (
      <div className="mt-5 space-y-5">
        <p className="text-sm text-muted-foreground">{t('auth.enrol.subtitle')}</p>
        {error === null ? (
          <div className="space-y-4" aria-busy="true">
            <span className="sr-only">{t('common.loading')}</span>
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
        <p className="text-xs text-muted-foreground">{t('auth.enrol.scan')}</p>
        <div className="flex justify-center">
          <Suspense fallback={<Skeleton className="size-44" />}>
            <TotpQr uri={enrolment.totpURI} label={t('auth.enrol.qr')} />
          </Suspense>
        </div>
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
          <Button variant="link" onClick={() => downloadCodes(enrolment.backupCodes, brandSlug)}>
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

/**
 * `<brand>-recovery-codes.txt`, after the brand's own slug when the screen knows it, so a
 * person with accounts in several places can tell the files apart (D-472).
 */
function recoveryCodesFileName(brandSlug: string | null | undefined): string {
  return typeof brandSlug === 'string' && /^[a-z0-9-]+$/.test(brandSlug)
    ? `${brandSlug}-recovery-codes.txt`
    : 'recovery-codes.txt';
}

function downloadCodes(codes: readonly string[], brandSlug: string | null | undefined): void {
  const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = recoveryCodesFileName(brandSlug);
  link.click();
  URL.revokeObjectURL(url);
}
