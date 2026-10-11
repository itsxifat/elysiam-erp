import type { MembershipRole } from '@elysium/contracts';
import {
  Button,
  ConfirmDialog,
  DateTime,
  ErrorState,
  PageHeader,
  Section,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound,
  LogOut,
  Monitor,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Tablet,
  type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { endpoints } from '../../api.js';
import { SESSION_QUERY_KEY, useSession } from '../../auth/session.js';
import { Alert, Field } from '../../ui/primitives.js';
import {
  ACCOUNT_QUERY_KEY,
  SESSIONS_QUERY_KEY,
  changePassword,
  endOtherSessions,
  endSession,
  getAccount,
  listSessions,
  updateName,
  type AccountView,
  type DeviceKind,
  type SessionView,
} from './api.js';
import {
  codesRunningLow,
  deviceName,
  orderSessions,
  passwordProblems,
  refusalText,
  requirementText,
  turnOffBlockedText,
  type PasswordForm,
} from './logic.js';
import { useAccountT } from './messages.js';
import { NewCodesDialog, NewPhoneDialog, SetUpDialog, TurnOffDialog } from './two-factor-dialogs.js';

/**
 * My account (M40, D-693 to D-695): the signed-in person's own name, password, two-step sign-in
 * and devices. Reached from the account menu, by everyone. Nothing here decides what is
 * allowed: "Turn off" is offered from the server's `canTurnOff`, and every change is checked
 * again there.
 */

const CHECKBOX =
  'mt-px size-4 shrink-0 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export function AccountPage() {
  const t = useAccountT();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ACCOUNT_QUERY_KEY, queryFn: getAccount });
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async (message?: string) => {
    if (message !== undefined) setNotice(message);
    await queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
  };

  return (
    <div className="max-w-page space-y-6">
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />
      {notice === null ? null : (
        <p
          role="status"
          className="rounded-md border border-border bg-success-subtle px-3 py-2 text-sm text-success-subtle-foreground"
        >
          {notice}
        </p>
      )}
      {query.isPending ? (
        <div className="space-y-6" aria-busy="true" aria-label={t('account.loading')}>
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-3 rounded-lg border border-border p-5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-9 w-full max-w-md" />
              <Skeleton className="h-9 w-2/3 max-w-sm" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          title={t('account.errorTitle')}
          detail={t('account.errorDetail')}
          action={
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('account.retry')}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <ProfileSection view={query.data} onSaved={refresh} />
          <PasswordSection view={query.data} onChanged={refresh} />
          <TwoFactorSection view={query.data} onChanged={refresh} />
          <DevicesSection onNotice={setNotice} />
        </div>
      )}
    </div>
  );
}

// --- profile ------------------------------------------------------------------------------

function useRoleName(): (role: string) => string {
  const t = useAccountT();
  return (role) => t(`users.role.${role as MembershipRole}`);
}

function ProfileSection({
  view,
  onSaved,
}: {
  readonly view: AccountView;
  readonly onSaved: (message: string) => Promise<void>;
}) {
  const t = useAccountT();
  const roleName = useRoleName();
  const queryClient = useQueryClient();
  const [name, setName] = useState(view.name);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => updateName(name.trim()),
    onSuccess: async () => {
      setProblem(null);
      // The account menu's monogram reads the name from Better Auth's session.
      await queryClient.invalidateQueries({ queryKey: ['auth-profile'] });
      await onSaved(t('account.profile.saved'));
    },
    onError: (cause) => setProblem(refusalText(cause, t)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') {
      setProblem(t('account.profile.nameRequired'));
      return;
    }
    save.mutate();
  };

  return (
    <Section title={t('account.profile.title')} description={t('account.profile.description')}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="account-name"
            name="name"
            label={t('account.profile.name')}
            autoComplete="name"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={problem ?? undefined}
          />
          <Field
            id="account-email"
            name="email"
            label={t('account.profile.email')}
            hint={t('account.profile.emailHint')}
            value={view.email}
            readOnly
            aria-readonly="true"
            className="bg-muted"
          />
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('account.profile.roles')}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {view.isOwner ? (
                <StatusBadge tone="info">{t('account.profile.owner')}</StatusBadge>
              ) : null}
              {view.isSuperAdmin && !view.isOwner ? (
                <StatusBadge tone="info">{t('account.profile.superAdmin')}</StatusBadge>
              ) : null}
              {view.roles.map((role) => (
                <StatusBadge key={role} tone="neutral">
                  {roleName(role)}
                </StatusBadge>
              ))}
              {view.roles.length === 0 && !view.isSuperAdmin ? (
                <span className="text-sm text-muted-foreground">
                  {t('account.profile.noRoles')}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('account.profile.lastSignIn')}</dt>
            <dd className="text-sm">
              {view.lastSignInAt === null ? (
                t('account.profile.never')
              ) : (
                <DateTime value={view.lastSignInAt} />
              )}
            </dd>
          </div>
        </dl>
        <Button type="submit" size="sm" disabled={save.isPending || name.trim() === view.name}>
          {save.isPending ? t('account.saving') : t('account.profile.save')}
        </Button>
      </form>
    </Section>
  );
}

// --- password -----------------------------------------------------------------------------

const EMPTY_PASSWORD: PasswordForm = {
  current: '',
  password: '',
  confirm: '',
  signOutOthers: true,
};

function PasswordSection({
  view,
  onChanged,
}: {
  readonly view: AccountView;
  readonly onChanged: (message: string) => Promise<void>;
}) {
  const t = useAccountT();
  const session = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PasswordForm>(EMPTY_PASSWORD);
  const [problems, setProblems] = useState<ReturnType<typeof passwordProblems>>({});
  const [refusal, setRefusal] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: async (values: PasswordForm) => {
      await changePassword({
        currentPassword: values.current,
        newPassword: values.password,
        revokeOtherSessions: values.signOutOthers,
      });
      // Signing the others out gives this device a fresh session with no brand chosen yet:
      // back into the one being worked in, so the page carries on where it was.
      const orgId = session.context?.orgId;
      if (values.signOutOthers && orgId !== undefined) await endpoints.setActiveOrg(orgId);
      return values.signOutOthers;
    },
    onSuccess: async (signedOut) => {
      setForm(EMPTY_PASSWORD);
      setRefusal(null);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      await onChanged(
        signedOut ? t('account.password.changedSignedOut') : t('account.password.changed'),
      );
    },
    onError: (cause) =>
      setRefusal(
        cause instanceof Error && 'code' in cause && cause.code === 'INVALID_PASSWORD'
          ? t('account.password.wrongCurrent')
          : refusalText(cause, t),
      ),
  });

  if (!view.hasPassword) {
    return (
      <Section title={t('account.password.title')}>
        <p className="text-sm text-muted-foreground">{t('account.password.none')}</p>
      </Section>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = passwordProblems(form, t);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    change.mutate(form);
  };

  return (
    <Section title={t('account.password.title')} description={t('account.password.description')}>
      <form onSubmit={submit} className="max-w-md space-y-4" noValidate>
        {/* For password managers: the account the password belongs to. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={view.email}
          readOnly
          hidden
        />
        <Field
          id="password-current"
          name="current-password"
          type="password"
          autoComplete="current-password"
          label={t('account.password.current')}
          value={form.current}
          onChange={(event) => setForm({ ...form, current: event.target.value })}
          error={problems.current}
        />
        <Field
          id="password-new"
          name="new-password"
          type="password"
          autoComplete="new-password"
          label={t('account.password.new')}
          maxLength={128}
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
          error={problems.password}
        />
        <Field
          id="password-confirm"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          label={t('account.password.confirm')}
          maxLength={128}
          value={form.confirm}
          onChange={(event) => setForm({ ...form, confirm: event.target.value })}
          error={problems.confirm}
        />
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={form.signOutOthers}
            onChange={(event) => setForm({ ...form, signOutOthers: event.target.checked })}
            aria-describedby="password-sign-out-hint"
          />
          <span>
            {t('account.password.signOutOthers')}
            <span id="password-sign-out-hint" className="block text-xs text-muted-foreground">
              {t('account.password.signOutOthersHint')}
            </span>
          </span>
        </label>
        {refusal === null ? null : <Alert>{refusal}</Alert>}
        <Button type="submit" size="sm" disabled={change.isPending}>
          <KeyRound aria-hidden="true" />
          {change.isPending ? t('account.saving') : t('account.password.submit')}
        </Button>
      </form>
    </Section>
  );
}

// --- two-step sign-in ---------------------------------------------------------------------

type Opened = 'setUp' | 'newPhone' | 'newCodes' | 'turnOff' | null;

function TwoFactorSection({
  view,
  onChanged,
}: {
  readonly view: AccountView;
  readonly onChanged: (message: string) => Promise<void>;
}) {
  const t = useAccountT();
  const roleName = useRoleName();
  const session = useSession();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<Opened>(null);
  const factor = view.twoFactor;
  const blocked = turnOffBlockedText(view, t);
  const brandSlug =
    session.orgs.find((org) => org.orgId === session.context?.orgId)?.slug ?? null;

  const done = async (message: string) => {
    setOpened(null);
    await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    await onChanged(message);
  };

  return (
    <Section
      title={t('account.twoFactor.title')}
      description={t('account.twoFactor.description')}
    >
      <div className="space-y-4">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('account.twoFactor.status')}</dt>
            <dd>
              <StatusBadge tone={factor.enabled ? 'success' : factor.required ? 'warning' : 'neutral'}>
                {factor.enabled ? t('account.twoFactor.on') : t('account.twoFactor.off')}
              </StatusBadge>
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('account.twoFactor.requirement')}</dt>
            <dd className="text-sm">{requirementText(view, t, roleName)}</dd>
          </div>
          {factor.enabled ? (
            <>
              <div className="space-y-1">
                <dt className="text-xs text-muted-foreground">{t('account.twoFactor.since')}</dt>
                <dd className="text-sm">
                  {factor.enabledAt === null ? (
                    t('account.twoFactor.sinceUnknown')
                  ) : (
                    <DateTime value={factor.enabledAt} />
                  )}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-xs text-muted-foreground">
                  {t('account.twoFactor.codesLeft')}
                </dt>
                <dd className="text-sm tabular-nums">{factor.backupCodesLeft ?? '—'}</dd>
              </div>
            </>
          ) : null}
        </dl>

        {factor.lockedUntil === null ? null : <Alert>{t('account.twoFactor.locked')}</Alert>}
        {!factor.enabled && factor.required && !view.isOwner ? (
          <p className="rounded-md border border-border bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground">
            {t('account.twoFactor.offRequired')}
          </p>
        ) : null}
        {factor.enabled && codesRunningLow(factor.backupCodesLeft) ? (
          <p className="rounded-md border border-border bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground">
            {t('account.twoFactor.codesLow')}
          </p>
        ) : null}

        {view.isOwner ? null : factor.enabled ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpened('newPhone')}>
                <Smartphone aria-hidden="true" />
                {t('account.twoFactor.newPhone')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setOpened('newCodes')}>
                <KeyRound aria-hidden="true" />
                {t('account.twoFactor.newCodes')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!factor.canTurnOff}
                aria-describedby={blocked === null ? undefined : 'two-factor-blocked'}
                onClick={() => setOpened('turnOff')}
              >
                <ShieldOff aria-hidden="true" />
                {t('account.twoFactor.turnOff')}
              </Button>
            </div>
            {blocked === null ? null : (
              <p id="two-factor-blocked" className="text-xs text-muted-foreground">
                {blocked}
              </p>
            )}
          </div>
        ) : (
          <Button size="sm" onClick={() => setOpened('setUp')}>
            <ShieldCheck aria-hidden="true" />
            {t('account.twoFactor.setUp')}
          </Button>
        )}
      </div>

      {opened === 'setUp' ? (
        <SetUpDialog brandSlug={brandSlug} onClose={() => setOpened(null)} onDone={done} />
      ) : null}
      {opened === 'newPhone' ? (
        <NewPhoneDialog onClose={() => setOpened(null)} onDone={done} />
      ) : null}
      {opened === 'newCodes' ? (
        <NewCodesDialog brandSlug={brandSlug} onClose={() => setOpened(null)} onDone={done} />
      ) : null}
      {opened === 'turnOff' ? (
        <TurnOffDialog onClose={() => setOpened(null)} onDone={done} />
      ) : null}
    </Section>
  );
}

// --- devices ------------------------------------------------------------------------------

const DEVICE_ICONS: Record<DeviceKind, LucideIcon> = {
  desktop: Monitor,
  phone: Smartphone,
  tablet: Tablet,
  unknown: Monitor,
};

function DevicesSection({ onNotice }: { readonly onNotice: (message: string) => void }) {
  const t = useAccountT();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: SESSIONS_QUERY_KEY, queryFn: listSessions });
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reload = () => queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  const endOne = useMutation({
    mutationFn: (id: string) => endSession(id),
    onSuccess: async () => {
      setProblem(null);
      onNotice(t('account.devices.signedOutOne'));
      await reload();
    },
    onError: async (cause) => {
      setProblem(refusalText(cause, t));
      await reload();
    },
  });

  const sessions = orderSessions(query.data ?? []);
  const others = sessions.filter((entry) => !entry.current);

  return (
    <Section
      title={t('account.devices.title')}
      description={t('account.devices.description')}
      actions={
        others.length === 0 ? undefined : (
          <Button size="sm" variant="outline" onClick={() => setConfirmOthers(true)}>
            <LogOut aria-hidden="true" />
            {t('account.devices.signOutOthers')}
          </Button>
        )
      }
    >
      {query.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label={t('account.loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorState
          title={t('account.errorTitle')}
          detail={t('account.errorDetail')}
          action={
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('account.retry')}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('account.devices.caption')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('account.devices.colDevice')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('account.devices.colAddress')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('account.devices.colSignedIn')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('account.devices.colLastActive')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">{t('account.devices.signOut')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((entry) => (
                  <DeviceRow
                    key={entry.id}
                    session={entry}
                    busy={endOne.isPending}
                    onSignOut={() => endOne.mutate(entry.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('account.devices.onlyThis')}</p>
          ) : null}
          {problem === null ? null : <Alert>{problem}</Alert>}
        </div>
      )}

      <ConfirmDialog
        open={confirmOthers}
        onOpenChange={setConfirmOthers}
        title={t('account.devices.signOutOthersTitle')}
        description={t('account.devices.signOutOthersDetail')}
        confirmLabel={t('account.devices.signOutOthers')}
        cancelLabel={t('account.cancel')}
        closeLabel={t('account.close')}
        destructive
        onConfirm={async () => {
          try {
            await endOtherSessions();
            onNotice(t('account.devices.signedOutOthers'));
          } catch (cause) {
            setProblem(refusalText(cause, t));
          }
          await reload();
        }}
      />
    </Section>
  );
}

function DeviceRow({
  session,
  busy,
  onSignOut,
}: {
  readonly session: SessionView;
  readonly busy: boolean;
  readonly onSignOut: () => void;
}) {
  const t = useAccountT();
  const Icon = DEVICE_ICONS[session.kind];
  const name = deviceName(session, t);
  return (
    <tr className="h-row border-b border-border last:border-b-0">
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">{name}</span>
          {session.current ? (
            <StatusBadge tone="success">{t('account.devices.thisDevice')}</StatusBadge>
          ) : null}
          {session.ownerLink ? (
            <StatusBadge tone="info">{t('account.devices.ownerLink')}</StatusBadge>
          ) : null}
        </div>
      </td>
      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground tabular-nums">
        {session.address ?? '—'}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap">
        <DateTime value={session.createdAt} />
      </td>
      <td className="py-2 pr-4 whitespace-nowrap">
        <DateTime value={session.lastActiveAt} />
      </td>
      <td className="py-2 text-right">
        {session.current ? null : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t('account.devices.signOutLabel', { device: name })}
            onClick={onSignOut}
          >
            <LogOut aria-hidden="true" />
            {t('account.devices.signOut')}
          </Button>
        )}
      </td>
    </tr>
  );
}
