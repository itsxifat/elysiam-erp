import { zodResolver } from '@hookform/resolvers/zod';
import { setPasswordSchema, type SetPassword } from '@elysium/contracts';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { ApiError, csrfToken, endpoints, NetworkError, type LoginBranding } from '../api.js';
import { useT } from '../i18n/locale.js';
import { Alert, Button, Field } from '../ui/primitives.js';
import { BrandMark } from './login-screen.js';
import { tokenFromHash, type PasswordLinkPage } from './password-link.js';

export { passwordLinkPage } from './password-link.js';

/**
 * Setting a password from a link an admin gave (gaps-users-auth, D-402).
 *
 * Two paths, one screen: `/accept-invite` for a new hire, `/reset-password` for someone
 * whose admin reset them. Served before the session check, because the person opening
 * it has no session — and must not be asked to sign in to set the password they would
 * sign in with.
 *
 * **The token rides in the fragment** (`#token=…`), which a browser never sends to any
 * server, so it reaches no access log, no proxy and no `Referer`. It is read once into
 * memory and the address bar is rewritten without it, so it is not left in the history
 * either. Better Auth's own `POST /api/auth/reset-password` redeems it, once.
 */

/** Take the token out of the address bar, once it is in memory. */
function readTokenOnce(): string | null {
  const token = tokenFromHash(window.location.hash);
  if (window.location.hash !== '') {
    window.history.replaceState(null, '', window.location.pathname);
  }
  return token;
}

export function SetPasswordScreen({
  page,
  branding,
}: {
  readonly page: PasswordLinkPage;
  readonly branding: LoginBranding | null;
}) {
  const t = useT();
  const [token] = useState(readTokenOnce);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const form = useForm<SetPassword>({
    resolver: zodResolver(setPasswordSchema),
    defaultValues: { password: '', confirm: '' },
  });

  const submit = form.handleSubmit(async ({ password }) => {
    if (token === null) return;
    setError(null);
    try {
      // The CSRF cookie arrives with the first GET; a fresh tab may not have made one.
      if (csrfToken() === '') await endpoints.branding(window.location.host);
      await endpoints.resetPassword(token, password);
      setDone(true);
    } catch (cause) {
      setError(messageFor(cause, t));
    }
  });

  const passwordError = form.formState.errors.password;
  const confirmError = form.formState.errors.confirm;

  return (
    <div className="grid min-h-dvh place-items-center bg-muted px-4 py-10">
      <div className="w-full max-w-sm">
        <BrandMark branding={branding} />

        <main className="mt-6 rounded-lg border border-border bg-card p-6 shadow-popover">
          {done ? (
            <div className="space-y-4">
              <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-card-foreground">
                <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
                {t('setPassword.doneTitle')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('setPassword.doneDetail')}</p>
              <Button onClick={() => window.location.assign('/')}>
                {t('setPassword.toSignIn')}
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-base font-semibold tracking-tight text-card-foreground">
                {page === 'invite' ? t('setPassword.inviteTitle') : t('setPassword.resetTitle')}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {page === 'invite'
                  ? t('setPassword.inviteSubtitle')
                  : t('setPassword.resetSubtitle')}
              </p>

              {token === null ? (
                <div className="mt-5">
                  <Alert>{t('setPassword.noToken')}</Alert>
                </div>
              ) : (
                <form
                  onSubmit={(event) => void submit(event)}
                  className="mt-5 space-y-4"
                  noValidate
                >
                  <Field
                    label={t('setPassword.password')}
                    type="password"
                    autoComplete="new-password"
                    autoFocus
                    hint={t('setPassword.passwordHint')}
                    {...form.register('password')}
                    error={
                      passwordError === undefined
                        ? undefined
                        : passwordError.type === 'too_big'
                          ? t('setPassword.tooLong')
                          : t('setPassword.tooShort')
                    }
                  />
                  <Field
                    label={t('setPassword.confirm')}
                    type="password"
                    autoComplete="new-password"
                    {...form.register('confirm')}
                    error={confirmError === undefined ? undefined : t('setPassword.mismatch')}
                  />

                  {error === null ? null : <Alert>{error}</Alert>}

                  <Button type="submit" busy={form.formState.isSubmitting}>
                    {form.formState.isSubmitting
                      ? t('setPassword.submitting')
                      : t('setPassword.submit')}
                  </Button>
                </form>
              )}
            </>
          )}
        </main>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {branding?.brand?.legalName ?? 'Elysium'}
        </p>
      </div>
    </div>
  );
}

/**
 * Say what went wrong. A used or expired link is the common case and has its own
 * words; Better Auth answers both with `INVALID_TOKEN`.
 */
function messageFor(cause: unknown, t: ReturnType<typeof useT>): string {
  if (cause instanceof NetworkError) return t('auth.unreachable');
  if (cause instanceof ApiError) {
    if (cause.status === 429) return t('auth.tooMany');
    if (cause.code === 'INVALID_TOKEN' || cause.code === 'USER_NOT_FOUND') {
      return t('setPassword.invalidLink');
    }
    if (cause.code === 'PASSWORD_TOO_SHORT') return t('setPassword.tooShort');
    if (cause.code === 'PASSWORD_TOO_LONG') return t('setPassword.tooLong');
  }
  return t('setPassword.failed');
}
