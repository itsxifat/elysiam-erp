import {
  Button,
  Checkbox,
  ConfirmDialog,
  DateTime,
  Dialog,
  ErrorState,
  Label,
  PageHeader,
  Section,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import {
  accountNameSchema,
  PASSWORD_MIN_LENGTH,
  passwordChangeSchema,
  type AccountSessionWire,
  type AccountWire,
  type AuthenticatorSetupWire,
} from '@elysium/mother-shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Laptop,
  Printer,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { ApiError, endpoints, NetworkError } from '../api.js';
import { secretFrom } from '../auth/sign-in.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { count } from '../ui/format.js';
import { Alert, Field, Notice } from '../ui/primitives.js';
import { copyCodes, downloadCodes, printCodes } from '../ui/recovery-codes.js';

/**
 * My account (M40, D-701 to D-705): the signed-in owner's name, password, two-step sign-in
 * and devices. Two-step sign-in is required for every owner and cannot be turned off
 * (D-487); here it can be moved to a new phone and its recovery codes renewed. Whatever
 * changes how the owner signs in asks for the password and a code held now. Every change is
 * checked and audited by the server; the screen only asks for what each needs.
 */

export const ACCOUNT_KEY = ['account'] as const;
export const SESSIONS_KEY = ['account', 'sessions'] as const;

/** What a refusal from `/v1/account` means, in the reader's words. */
export function accountErrorKey(cause: unknown): MessageKey {
  if (cause instanceof NetworkError) return 'auth.unreachable';
  if (cause instanceof ApiError) {
    if (cause.status === 429) return 'account.error.locked';
    switch (cause.code) {
      case 'INVALID_PASSWORD':
        return 'account.error.password';
      case 'INVALID_CODE':
        return 'account.error.code';
      case 'TWO_FACTOR_SETUP_EXPIRED':
        return 'account.error.expired';
      case null:
      default:
        return 'common.errorDetail';
    }
  }
  return 'common.errorDetail';
}

export function AccountPage() {
  const { t } = useLocale();
  const account = useQuery({ queryKey: ACCOUNT_KEY, queryFn: endpoints.account });

  return (
    <div className="space-y-6">
      <PageHeader title={t('account.title')} description={t('account.description')} />
      {account.isPending ? (
        <div className="space-y-6" aria-busy="true">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-56 w-full" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      ) : account.isError ? (
        <ErrorState title={t('common.error')} detail={t('common.errorDetail')} />
      ) : (
        <>
          <Profile account={account.data} />
          <Password account={account.data} />
          <TwoStep account={account.data} />
          <Devices />
        </>
      )}
    </div>
  );
}

// --- profile ------------------------------------------------------------------------------

function Profile({ account }: { readonly account: AccountWire }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [name, setName] = useState(account.name);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const rename = useMutation({
    mutationFn: (next: string) => endpoints.rename(next),
    onSuccess: async (result) => {
      queryClient.setQueryData(ACCOUNT_KEY, result);
      // The shell's name comes from `/v1/me`.
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
    },
    onError: (cause) => setError(accountErrorKey(cause)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setError(null);
    const parsed = accountNameSchema.safeParse({ name });
    if (!parsed.success) {
      setError('form.required');
      return;
    }
    rename.mutate(parsed.data.name);
  }

  const unchanged = name.trim() === account.name;
  return (
    <Section title={t('account.profile')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('account.name')}
            autoComplete="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
            error={error === 'form.required' ? t('form.required') : undefined}
          />
          <Field
            label={t('account.email')}
            hint={t('account.emailHint')}
            type="email"
            value={account.email}
            readOnly
          />
        </div>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t('account.memberSince')}</dt>
            <dd className="mt-1">
              <DateTime value={account.createdAt} compact />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('account.lastSignIn')}</dt>
            <dd className="mt-1">
              {account.lastSignInAt === null ? (
                t('people.never')
              ) : (
                <DateTime value={account.lastSignInAt} compact />
              )}
            </dd>
          </div>
        </dl>
        {error !== null && error !== 'form.required' ? <Alert>{t(error)}</Alert> : null}
        {saved ? <Notice>{t('account.nameSaved')}</Notice> : null}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={rename.isPending || unchanged}>
            {t('account.saveName')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

// --- password -----------------------------------------------------------------------------

function Password({ account }: { readonly account: AccountWire }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const othersId = useId();
  const [current, setCurrent] = useState('');
  const [code, setCode] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [done, setDone] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    setProblem(null);
    if (next.length < PASSWORD_MIN_LENGTH) {
      setProblem('auth.setPassword.tooShort');
      return;
    }
    if (next !== repeat) {
      setProblem('auth.setPassword.mismatch');
      return;
    }
    const parsed = passwordChangeSchema.safeParse({
      currentPassword: current,
      code,
      newPassword: next,
      signOutOtherDevices: signOutOthers,
    });
    if (!parsed.success) {
      setProblem(
        current === '' || code.trim().length < 6 ? 'form.invalid' : 'account.passwordSame',
      );
      return;
    }
    setBusy(true);
    try {
      await endpoints.changePassword(parsed.data);
      setCurrent('');
      setCode('');
      setNext('');
      setRepeat('');
      setDone(signOutOthers ? 'account.passwordChangedOthers' : 'account.passwordChanged');
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY });
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    } catch (cause) {
      setProblem(accountErrorKey(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title={t('account.password')}
      description={
        account.passwordChangedAt === null ? undefined : (
          <>
            {t('account.passwordChangedAt')} <DateTime value={account.passwordChangedAt} compact />
          </>
        )
      }
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('account.currentPassword')}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <Field
            label={t('account.codeNow')}
            hint={t('account.codeNowHint')}
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('account.newPassword')}
            hint={t('account.passwordHint')}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Field
            label={t('account.repeatPassword')}
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={othersId}
            checked={signOutOthers}
            onCheckedChange={(checked) => setSignOutOthers(checked === true)}
          />
          <Label htmlFor={othersId}>{t('account.signOutOthers')}</Label>
        </div>
        {problem === null ? null : <Alert>{t(problem)}</Alert>}
        {done === null ? null : <Notice>{t(done)}</Notice>}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={busy || current === '' || code.trim() === '' || next === ''}
          >
            {busy ? t('account.changing') : t('account.changePassword')}
          </Button>
        </div>
      </form>
    </Section>
  );
}

// --- two-step sign-in ---------------------------------------------------------------------

function TwoStep({ account }: { readonly account: AccountWire }) {
  const { t, locale } = useLocale();
  const [moving, setMoving] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const left = account.twoFactor.backupCodesLeft;

  return (
    <Section
      title={t('account.twoFactor')}
      actions={<StatusBadge tone="success">{t('account.twoFactorOn')}</StatusBadge>}
    >
      <div className="space-y-4">
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
          {t('account.twoFactorRequired')}
        </p>
        <dl className="text-sm">
          <dt className="text-xs text-muted-foreground">{t('account.recoveryLeft')}</dt>
          <dd className="mt-1 tabular-nums">
            {left === null
              ? t('account.recoveryUnknown')
              : `${count(left, locale)} ${t('account.recoveryOf')} ${count(account.twoFactor.backupCodesIssued, locale)}`}
            {left !== null && left <= 3 ? (
              <span className="ml-2">
                <StatusBadge tone="warning">{t('account.recoveryLow')}</StatusBadge>
              </span>
            ) : null}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setMoving(true)}>
            <Smartphone aria-hidden="true" />
            {t('account.newPhone')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRenewing(true)}>
            <KeyRound aria-hidden="true" />
            {t('account.newCodes')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('account.lostBoth')}</p>
      </div>
      {moving ? <NewPhoneDialog onClose={() => setMoving(false)} /> : null}
      {renewing ? <RecoveryCodesDialog onClose={() => setRenewing(false)} /> : null}
    </Section>
  );
}

/**
 * Two steps (D-702): prove the factor held now (the password and a code from the current
 * app, or a recovery code), then add the new key and enter its first code, optionally
 * signing out every other device (a lost or stolen phone). The old phone keeps working
 * until that code is right.
 */
export function NewPhoneDialog({ onClose }: { readonly onClose: () => void }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [setup, setSetup] = useState<AuthenticatorSetupWire | null>(null);
  const [code, setCode] = useState('');
  const othersId = useId();
  const [signOutOthers, setSignOutOthers] = useState(false);
  const [done, setDone] = useState<MessageKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setSetup(await endpoints.startNewApp(password, current.trim()));
      setPassword('');
      setCurrent('');
      // A recovery code may have been used up.
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY });
    } catch (cause) {
      setError(accountErrorKey(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await endpoints.confirmNewApp(code.replace(/\s/g, ''), signOutOthers);
      setDone(signOutOthers ? 'account.newPhone.doneOthers' : 'account.newPhone.done');
      await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    } catch (cause) {
      const key = accountErrorKey(cause);
      setError(key);
      if (key === 'account.error.expired') {
        setSetup(null);
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  const key = setup === null ? '' : secretFrom(setup.totpURI);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('account.newPhone')}
      description={t('account.newPhone.description')}
      closeLabel={t('common.close')}
    >
      {done !== null ? (
        <div className="space-y-4">
          <Notice>{t(done)}</Notice>
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('account.done')}</Button>
          </div>
        </div>
      ) : setup === null ? (
        <form onSubmit={(event) => void start(event)} className="space-y-4" noValidate>
          <Field
            label={t('account.yourPassword')}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Field
            label={t('account.codeNow')}
            hint={t('account.codeNowHint')}
            autoComplete="one-time-code"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          {error === null ? null : <Alert>{t(error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || password === '' || current.trim().length < 6}>
              {t('account.newPhone.continue')}
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={(event) => void confirm(event)} className="space-y-5" noValidate>
          <Step
            icon={<KeyRound className="size-4" aria-hidden="true" />}
            label={t('account.newPhone.step1')}
          >
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                {key}
              </code>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={copied ? t('common.copied') : t('common.copy')}
                onClick={() => {
                  void navigator.clipboard.writeText(key).then(() => setCopied(true));
                }}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </Button>
            </div>
            <a
              href={setup.totpURI}
              className="inline-block rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('account.newPhone.openApp')}
            </a>
            <p className="text-xs text-muted-foreground">
              {t('account.newPhone.expires')} <DateTime value={setup.expiresAt} compact />
            </p>
          </Step>
          <Field
            label={t('account.newPhone.step2')}
            autoComplete="one-time-code"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="text-center font-mono text-base tracking-[0.3em] tabular-nums"
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id={othersId}
              checked={signOutOthers}
              onCheckedChange={(checked) => setSignOutOthers(checked === true)}
            />
            <Label htmlFor={othersId}>{t('account.newPhone.signOutOthers')}</Label>
          </div>
          {error === null ? null : <Alert>{t(error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>
              {t('account.newPhone.confirm')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** New recovery codes (D-703): the password and a code held now, then the codes, shown once. */
export function RecoveryCodesDialog({ onClose }: { readonly onClose: () => void }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const savedId = useId();
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function make(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await endpoints.renewBackupCodes(password, current.trim());
      setPassword('');
      setCurrent('');
      setCodes(result.backupCodes);
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY });
    } catch (cause) {
      setError(accountErrorKey(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('account.newCodes')}
      description={codes === null ? t('account.codes.description') : t('account.codes.shownOnce')}
      closeLabel={t('common.close')}
    >
      {codes === null ? (
        <form onSubmit={(event) => void make(event)} className="space-y-4" noValidate>
          <Field
            label={t('account.yourPassword')}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Field
            label={t('account.codeNow')}
            hint={t('account.codeNowHint')}
            autoComplete="one-time-code"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          {error === null ? null : <Alert>{t(error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || password === '' || current.trim().length < 6}>
              {t('account.codes.make')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <ul
            aria-label={t('account.codes.list')}
            className="grid grid-cols-2 gap-1.5 rounded-md bg-muted p-3 font-mono text-sm text-foreground"
          >
            {codes.map((code) => (
              <li key={code} className="tabular-nums">
                {code}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyCodes(codes).then(() => setCopied(true))}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => downloadCodes(codes)}>
              <Download aria-hidden="true" />
              {t('auth.enrol.download')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => printCodes(codes, t('account.codes.printTitle'))}
            >
              <Printer aria-hidden="true" />
              {t('account.codes.print')}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={savedId}
              checked={saved}
              onCheckedChange={(checked) => setSaved(checked === true)}
            />
            <Label htmlFor={savedId}>{t('auth.enrol.acknowledge')}</Label>
          </div>
          <div className="flex justify-end">
            <Button disabled={!saved} onClick={onClose}>
              {t('account.done')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
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
      <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </h3>
      {children}
    </section>
  );
}

// --- devices ------------------------------------------------------------------------------

export function deviceLabel(
  session: Pick<AccountSessionWire, 'browser' | 'os'>,
  t: (key: MessageKey) => string,
): string {
  return `${session.browser ?? t('account.devices.unknownBrowser')} · ${
    session.os ?? t('account.devices.unknownSystem')
  }`;
}

function isPhone(session: AccountSessionWire): boolean {
  return session.os === 'Android' || session.os === 'iPhone' || session.os === 'iPad';
}

export function Devices() {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: endpoints.sessions });
  const [ending, setEnding] = useState<AccountSessionWire | null>(null);
  const [endingAll, setEndingAll] = useState(false);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });

  const list = sessions.data?.sessions ?? [];
  const others = list.filter((session) => !session.current).length;

  return (
    <Section
      title={t('account.devices')}
      description={t('account.devices.description')}
      bodyClassName="p-0"
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={others === 0}
          onClick={() => setEndingAll(true)}
        >
          {t('account.devices.signOutAll')}
        </Button>
      }
    >
      {notice === null ? null : <Notice className="mx-5 mb-3">{t(notice)}</Notice>}
      {error === null ? null : <Alert className="mx-5 mb-3">{t(error)}</Alert>}
      {sessions.isPending ? (
        <div className="px-5 pb-5">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : sessions.isError ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{t('common.errorDetail')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">{t('account.devices')}</caption>
            <thead>
              <tr className="border-y border-border text-xs text-muted-foreground">
                <th scope="col" className="px-5 py-2 text-left font-medium">
                  {t('account.devices.device')}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t('account.devices.address')}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t('account.devices.signedIn')}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  {t('account.devices.lastActive')}
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  <span className="sr-only">{t('people.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((session) => {
                const Icon = isPhone(session) ? Smartphone : Laptop;
                return (
                  <tr key={session.id} className="border-b border-border last:border-0">
                    <th scope="row" className="px-5 py-2.5 text-left font-normal">
                      <span className="flex items-center gap-2">
                        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                        <span className="font-medium">{deviceLabel(session, t)}</span>
                        {session.current ? (
                          <StatusBadge tone="info">{t('account.devices.thisDevice')}</StatusBadge>
                        ) : null}
                      </span>
                    </th>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {session.address ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <DateTime value={session.createdAt} compact />
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <DateTime value={session.lastActiveAt} compact />
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {session.current ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`${t('account.devices.signOut')}: ${deviceLabel(session, t)}`}
                          onClick={() => setEnding(session)}
                        >
                          {t('account.devices.signOut')}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {others === 0 ? (
            <p className="px-5 py-3 text-sm text-muted-foreground">{t('account.devices.none')}</p>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        title={
          ending === null
            ? t('account.devices.signOut')
            : `${t('account.devices.signOut')}: ${deviceLabel(ending, t)}`
        }
        description={t('account.devices.signOutConfirm')}
        confirmLabel={t('account.devices.signOut')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        destructive
        onConfirm={async () => {
          if (ending === null) return;
          setError(null);
          try {
            await endpoints.signOutSession(ending.id);
            setNotice('account.devices.signedOutOne');
          } catch (cause) {
            setError(accountErrorKey(cause));
          }
          setEnding(null);
          await refresh();
        }}
      />
      <ConfirmDialog
        open={endingAll}
        onOpenChange={setEndingAll}
        title={t('account.devices.signOutAll')}
        description={t('account.devices.signOutAllConfirm')}
        confirmLabel={t('account.devices.signOutAll')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        destructive
        onConfirm={async () => {
          setError(null);
          try {
            await endpoints.signOutOtherSessions();
            setNotice('account.devices.signedOutOthers');
          } catch (cause) {
            setError(accountErrorKey(cause));
          }
          setEndingAll(false);
          await refresh();
        }}
      />
    </Section>
  );
}
