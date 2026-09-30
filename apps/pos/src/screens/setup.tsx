import { Button, EmptyState, ErrorState, Input, Label, Skeleton, takaToPoisha } from '@elysium/ui';
import { KeyRound, Store } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { usePosT } from '../i18n/locale.js';
import {
  ApiError,
  endpoints,
  NetworkError,
  type AvailableOrg,
  type RegisterView,
} from '../lib/api.js';

/**
 * The screens before the first sale: sign in, choose a brand, choose this till's
 * register, open a shift. Each needs the server once; after that the till can sell
 * offline for as long as the shift lasts.
 */

export function Panel({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-md flex-col justify-center px-6 py-10"
    >
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {detail === undefined ? null : <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
      <div className="mt-6 space-y-4">{children}</div>
    </main>
  );
}

function Alert({ children }: { readonly children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
    >
      {children}
    </p>
  );
}

export function SignIn({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const t = usePosT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsCode) {
        await endpoints.verifyTotp(code.trim());
        onSignedIn();
        return;
      }
      const result = await endpoints.signIn(email.trim(), password);
      if (result.twoFactorRedirect === true) setNeedsCode(true);
      else onSignedIn();
    } catch (caught) {
      setError(caught instanceof NetworkError ? t('pos.signIn.offline') : t('pos.signIn.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={t('pos.signIn.title')}>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        {needsCode ? (
          <div className="space-y-1.5">
            <Label htmlFor="totp">{t('pos.signIn.totp')}</Label>
            <Input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              className="h-control-lg"
            />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="email">{t('pos.signIn.email')}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                className="h-control-lg"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">{t('pos.signIn.password')}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
                className="h-control-lg"
              />
            </div>
          </>
        )}
        {error === null ? null : <Alert>{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          <KeyRound aria-hidden />
          {needsCode ? t('pos.signIn.verify') : t('pos.signIn.submit')}
        </Button>
      </form>
    </Panel>
  );
}

export function PickOrg({ onPicked }: { readonly onPicked: () => void }) {
  const t = usePosT();
  const [orgs, setOrgs] = useState<readonly AvailableOrg[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    endpoints
      .myOrgs()
      .then(async ({ orgs: list }) => {
        if (list.length === 1 && list[0] !== undefined) {
          // One brand: never show a switcher (D-035).
          await endpoints.setActiveOrg(list[0].orgId);
          onPicked();
          return;
        }
        setOrgs(list);
      })
      .catch(() => {
        setError(true);
      });
  }, [onPicked]);

  if (error)
    return (
      <Panel title={t('pos.signIn.pickOrg')}>
        <ErrorState title={t('pos.error.generic')} />
      </Panel>
    );
  if (orgs === null) {
    return (
      <Panel title={t('pos.signIn.pickOrg')}>
        <Skeleton className="h-control-lg w-full" />
        <Skeleton className="h-control-lg w-full" />
      </Panel>
    );
  }
  if (orgs.length === 0)
    return (
      <Panel title={t('pos.signIn.pickOrg')}>
        <EmptyState title={t('pos.signIn.noOrgs')} />
      </Panel>
    );
  return (
    <Panel title={t('pos.signIn.pickOrg')}>
      {orgs.map((org) => (
        <Button
          key={org.orgId}
          size="lg"
          variant="outline"
          className="w-full justify-start"
          onClick={() => {
            void endpoints.setActiveOrg(org.orgId).then(onPicked);
          }}
        >
          {org.displayName}
        </Button>
      ))}
    </Panel>
  );
}

export function PickRegister({
  onPicked,
}: {
  readonly onPicked: (register: RegisterView) => void;
}) {
  const t = usePosT();
  const [registers, setRegisters] = useState<readonly RegisterView[] | null>(null);
  const [error, setError] = useState<'failed' | 'denied' | null>(null);

  useEffect(() => {
    endpoints
      .registers()
      .then(({ items }) => {
        setRegisters(items.filter((register) => register.isActive));
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError && caught.status === 403 ? 'denied' : 'failed');
      });
  }, []);

  return (
    <Panel title={t('pos.register.title')} detail={t('pos.register.detail')}>
      {error === 'denied' ? <Alert>{t('pos.error.permission')}</Alert> : null}
      {error === 'failed' ? <ErrorState title={t('pos.register.loadFailed')} /> : null}
      {registers === null && error === null ? (
        <>
          <Skeleton className="h-control-lg w-full" />
          <Skeleton className="h-control-lg w-full" />
        </>
      ) : null}
      {registers?.length === 0 ? <EmptyState title={t('pos.register.none')} /> : null}
      {registers?.map((register) => (
        <Button
          key={register.id}
          size="lg"
          variant="outline"
          className="w-full justify-between"
          onClick={() => {
            onPicked(register);
          }}
        >
          <span className="inline-flex items-center gap-2">
            <Store aria-hidden />
            {register.name}
          </span>
          <span className="text-muted-foreground">
            {register.branchName} · {register.code}
          </span>
        </Button>
      ))}
    </Panel>
  );
}

export function OpenShift({
  registerId,
  online,
  onOpened,
}: {
  readonly registerId: string;
  readonly online: boolean;
  readonly onOpened: () => void;
}) {
  const t = usePosT();
  const [float, setFloat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const poisha = takaToPoisha(float);
    if (poisha === null || poisha.startsWith('-')) {
      setError(t('pos.shift.floatInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.openShift({
        shiftId: crypto.randomUUID(),
        registerId,
        openingFloatPoisha: poisha,
      });
      onOpened();
    } catch (caught) {
      setError(
        caught instanceof NetworkError
          ? t('pos.shift.needsOnline')
          : caught instanceof ApiError && caught.status === 409
            ? t('pos.shift.someoneElse')
            : t('pos.shift.openFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={t('pos.shift.openTitle')} detail={t('pos.shift.openDetail')}>
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <div className="space-y-1.5">
          <Label htmlFor="float">{t('pos.shift.float')}</Label>
          <Input
            id="float"
            inputMode="decimal"
            autoFocus
            value={float}
            onChange={(event) => {
              setFloat(event.target.value);
            }}
            className="h-control-lg text-right tabular-nums"
          />
        </div>
        {!online ? <Alert>{t('pos.shift.needsOnline')}</Alert> : null}
        {error === null ? null : <Alert>{error}</Alert>}
        <Button type="submit" size="lg" className="w-full" disabled={busy || !online}>
          {t('pos.shift.open')}
        </Button>
      </form>
    </Panel>
  );
}
