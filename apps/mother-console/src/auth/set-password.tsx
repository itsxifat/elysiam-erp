import { Button } from '@elysium/ui';
import { useState, type FormEvent } from 'react';

import { ApiError, endpoints, NetworkError } from '../api.js';
import { useT, type MessageKey } from '../i18n/locale.js';
import { Alert, Field, Notice } from '../ui/primitives.js';

/**
 * Redeeming an invite (D-487): `/accept-invite#token=…`. The token rides in the fragment,
 * which no browser sends to a server and no log records, and is read here only to be posted.
 */

export function isInvitePath(pathname: string): boolean {
  return pathname === '/accept-invite';
}

function tokenFromHash(): string {
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  return match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
}

export function SetPasswordScreen({ onDone }: { readonly onDone: () => void }) {
  const t = useT();
  const [token] = useState(tokenFromHash);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<MessageKey | null>(
    token === '' ? 'auth.setPassword.invalid' : null,
  );
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 12) {
      setError('auth.setPassword.tooShort');
      return;
    }
    if (password !== repeat) {
      setError('auth.setPassword.mismatch');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.setPassword(token, password);
      // The token is spent: take it out of the address bar and the history.
      window.history.replaceState(null, '', '/');
      setDone(true);
    } catch (cause) {
      setError(
        cause instanceof NetworkError
          ? 'auth.unreachable'
          : cause instanceof ApiError && cause.status === 429
            ? 'auth.tooMany'
            : 'auth.setPassword.invalid',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <main className="w-full max-w-sm rounded-xl border border-border bg-card p-7 shadow-popover">
        <h1 className="text-lg font-semibold tracking-tight text-card-foreground">
          {t('auth.setPassword.title')}
        </h1>
        {done ? (
          <div className="mt-5 space-y-4">
            <Notice>{t('auth.setPassword.done')}</Notice>
            <Button className="w-full" onClick={onDone}>
              {t('auth.setPassword.toSignIn')}
            </Button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="mt-5 space-y-4" noValidate>
            <p className="text-sm text-muted-foreground">{t('auth.setPassword.subtitle')}</p>
            <Field
              label={t('auth.setPassword.password')}
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Field
              label={t('auth.setPassword.repeat')}
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
            />
            {error === null ? null : <Alert>{t(error)}</Alert>}
            <Button type="submit" className="w-full" disabled={busy || token === ''}>
              {t('auth.setPassword.submit')}
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
