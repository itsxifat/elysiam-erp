import type { MembershipRole } from '@elysium/contracts';
import { formatCount, type Locale } from '@elysium/i18n';
import {
  Button,
  ConfirmDialog,
  DataTable,
  DateTime,
  Dialog,
  Monogram,
  PageHeader,
  PermissionGate,
  Select,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Crown,
  KeyRound,
  LogOut,
  ShieldCheck,
  ShieldMinus,
  ShieldOff,
  ShieldX,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { decideApproval } from '../../api/approvals.js';
import { useAbility, useSession } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { useStaffNames } from '../../staff-names.js';
import { Field } from '../../ui/primitives.js';
import { listBranches, type BranchRow } from '../branches/api.js';
import {
  deactivate,
  invite,
  listStaff,
  passwordLink,
  resetTwoFactor,
  setRoles,
  signOutEverywhere,
  stepDown,
  turnOffTwoFactor,
  voteSuperAdmin,
  voteSuperAdminRemoval,
  voteTrust,
  withdrawSuperAdmin,
  withdrawSuperAdminRemoval,
  withdrawTrust,
  type NominationOutcome,
  type NominationView,
  type OpenReset,
  type RemovalView,
  type StaffRow,
  type StaffStatus,
  type TrustView,
} from './api.js';
import { DeskSection } from './desk-section.js';
import { orderedRoles, passwordLinkUrl, rolesToSubmit } from './link.js';
import { useUsersT, type UsersMessageKey } from './messages.js';
import { listAssignments } from '../calls/api.js';
import { useTelT } from '../calls/messages.js';

/**
 * The Staff screen (gaps-users-auth): a brand's people, what each may do, and their
 * sign-in — and the admin's four actions on them: change roles, deactivate a leaver,
 * hand over a password link, reset a lost phone's second factor.
 *
 * Nothing here decides who may do what to whom. The buttons are offered from the facts
 * the server sent (`isSelf`, `inOtherBrand`, `resetNeedsApproval`…), and every one of
 * them is checked again, and explained, by the server (`planCredentialReset`).
 */

const SINGLE_PAGE = { page: 1, pageSize: 500, total: null, hasNext: false } as const;
const CHECKBOX =
  'size-4 shrink-0 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

const STATUS: Record<
  StaffStatus,
  { key: UsersMessageKey; tone: 'success' | 'info' | 'neutral' | 'danger' }
> = {
  active: { key: 'users.statusActive', tone: 'success' },
  invited: { key: 'users.statusInvited', tone: 'info' },
  deactivated: { key: 'users.statusDeactivated', tone: 'neutral' },
  disabled: { key: 'users.statusDisabled', tone: 'danger' },
};

function roleKey(role: MembershipRole): UsersMessageKey {
  return `users.role.${role}` as UsersMessageKey;
}

/** "Trusted", or how far from it: "1 of 2 votes" (D-654). */
function trustLabel(trust: TrustView, u: (key: UsersMessageKey) => string, locale: Locale): string {
  return trust.trusted
    ? u('users.trusted')
    : u('users.trustVotes')
        .replace('{n}', formatCount(trust.votes, locale))
        .replace('{m}', formatCount(trust.needed, locale));
}

/** A pending super admin nomination: "Super admin: 1 of 2 votes" (D-659). */
function nominationLabel(
  nomination: NominationView,
  u: (key: UsersMessageKey) => string,
  locale: Locale,
): string {
  return u('users.superAdminPending')
    .replace('{n}', formatCount(nomination.votes, locale))
    .replace('{m}', formatCount(nomination.needed, locale));
}

/** A pending super admin removal: "Removal: 1 of 2 votes" (D-686). */
function removalLabel(
  removal: RemovalView,
  u: (key: UsersMessageKey) => string,
  locale: Locale,
): string {
  return u('users.removalPending')
    .replace('{n}', formatCount(removal.votes, locale))
    .replace('{m}', formatCount(removal.needed, locale));
}

/** An owner is "Owner" to everyone but another owner (D-473, D-658). */
function displayName(row: StaffRow, u: (key: UsersMessageKey) => string): string {
  return row.isOwner && row.name === '' ? u('users.owner') : row.name;
}

/** What the page says once a super admin's yes has landed (D-659). */
function nominationNotice(
  outcome: NominationOutcome,
  name: string,
  u: (key: UsersMessageKey) => string,
): string {
  return (
    outcome.outcome === 'promoted' ? u('users.superAdminPromoted') : u('users.superAdminWaiting')
  ).replace('{name}', name);
}

/** The server's problem+json detail is written to be shown; anything else never reached it. */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

type Action = 'deactivate' | 'password' | 'invite' | 'twoFactor' | 'turnOff';

type Pending = {
  readonly action: Action;
  readonly row: StaffRow;
} | null;

/** A super admin removal action waiting for its confirmation (D-685, D-686). */
type Removing = {
  readonly kind: 'stepDown' | 'remove' | 'withdraw';
  readonly row: StaffRow;
  readonly removal: RemovalView;
} | null;

interface IssuedLink {
  readonly name: string;
  readonly kind: 'invite' | 'password';
  readonly token: string;
  readonly expiresAt: string;
}

export function UsersPage() {
  const ability = useAbility();
  const session = useSession();
  const t = useT();
  const u = useUsersT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'User');
  const mayChange = ability.can('update', 'User');
  const mayInvite = ability.can('create', 'User');
  const isSuperAdmin = session.context?.isSuperAdmin ?? false;

  const [manageId, setManageId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState<'staff' | 'superAdmin' | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [link, setLink] = useState<IssuedLink | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Removing>(null);
  const [signingOut, setSigningOut] = useState<StaffRow | null>(null);

  const staffQuery = useQuery({ queryKey: ['users'], queryFn: listStaff, enabled: mayRead });
  const branchesQuery = useQuery({
    queryKey: ['users', 'branches'],
    queryFn: listBranches,
    enabled: mayChange && ability.can('read', 'LedgerReport'),
  });
  const branches = useMemo(() => branchesQuery.data?.items ?? [], [branchesQuery.data]);
  // M47 (D-846): each person's Envo extension, for the desk's supervisors.
  const tel = useTelT();
  const assignmentsQuery = useQuery({
    queryKey: ['telephony', 'assignments'],
    queryFn: listAssignments,
    enabled: mayRead && ability.can('read', 'PhoneExtension'),
  });
  const extensions = useMemo(
    () => new Map((assignmentsQuery.data?.items ?? []).map((row) => [row.userId, row.extension])),
    [assignmentsQuery.data],
  );
  const showExtensions = assignmentsQuery.data !== undefined;

  // A second admin's decision arrives as an approval event; the list is simply re-read.
  useRealtime({
    events: ['approval.requested', 'approval.decided'],
    enabled: mayRead,
    onEvent: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const items = staffQuery.data?.items ?? [];
  const resets = staffQuery.data?.resets ?? [];
  const managed = items.find((row) => row.userId === manageId) ?? null;
  // D-898: a person no longer on the list (a leaver, a super admin) by name, never by id.
  const staff = useStaffNames(resets.flatMap((reset) => [reset.userId, reset.requestedBy]));
  const nameOf = (userId: string) =>
    items.find((row) => row.userId === userId)?.name ?? staff(userId) ?? '—';

  const columns = useMemo<readonly DataTableColumn<StaffRow>[]>(() => {
    const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? id;
    const column = dataTableColumns<StaffRow>();
    return column.columns([
      column.accessor('name', {
        header: u('users.colName'),
        cell: (cell) => {
          const row = cell.row.original;
          const name = displayName(row, u);
          return (
            <div className="flex min-w-0 items-center gap-3 py-1.5">
              <Monogram name={name} size="md" className="rounded-full" />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 font-medium">
                  {name}
                  {row.isSelf ? <StatusBadge tone="neutral">{u('users.you')}</StatusBadge> : null}
                  {row.isOwner && row.name !== '' ? (
                    <StatusBadge tone="info">{u('users.owner')}</StatusBadge>
                  ) : null}
                  {row.isSuperAdmin ? (
                    <StatusBadge tone="info">{u('users.superAdmin')}</StatusBadge>
                  ) : null}
                  {row.superAdminNomination?.pending === true ? (
                    <StatusBadge tone="warning">
                      {nominationLabel(row.superAdminNomination, u, locale)}
                    </StatusBadge>
                  ) : null}
                  {row.superAdminRemoval?.pending === true ? (
                    <StatusBadge tone="warning">
                      {removalLabel(row.superAdminRemoval, u, locale)}
                    </StatusBadge>
                  ) : null}
                  {row.trust === null ? null : (
                    <StatusBadge tone={row.trust.trusted ? 'success' : 'neutral'}>
                      {trustLabel(row.trust, u, locale)}
                    </StatusBadge>
                  )}
                </p>
                {row.email === '' ? null : (
                  <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                )}
              </div>
            </div>
          );
        },
      }),
      column.display({
        id: 'roles',
        header: u('users.colRoles'),
        cell: (cell) => {
          const row = cell.row.original;
          const shown = row.roles.length > 0 ? row.roles : [];
          if (shown.length === 0) {
            return (
              <span className="text-sm text-muted-foreground">
                {row.formerRoles.map((role) => u(roleKey(role))).join(', ')}
              </span>
            );
          }
          return (
            <ul className="space-y-0.5 text-sm">
              {shown.map((grant) => (
                <li key={grant.role}>
                  {u(roleKey(grant.role))}
                  {grant.branchIds.length === 0 ? null : (
                    <span className="text-muted-foreground">
                      {' · '}
                      {grant.branchIds.map(branchName).join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          );
        },
      }),
      ...(showExtensions
        ? [
            column.display({
              id: 'extension',
              header: tel('tel.staff.extension'),
              cell: (cell) => {
                const extension = extensions.get(cell.row.original.userId);
                return extension === undefined ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="tabular-nums">{extension}</span>
                );
              },
            }),
          ]
        : []),
      column.accessor('status', {
        header: u('users.colStatus'),
        cell: (cell) => {
          const status = STATUS[cell.getValue()];
          return <StatusBadge tone={status.tone}>{u(status.key)}</StatusBadge>;
        },
      }),
      column.display({
        id: 'twoFactor',
        header: u('users.colTwoFactor'),
        cell: (cell) => {
          const row = cell.row.original;
          // The state, and under it whether the brand's setting requires it (M40, D-691).
          const badge = row.twoFactorEnabled ? (
            <StatusBadge tone="success">{u('users.twoFactorOn')}</StatusBadge>
          ) : row.twoFactorRequired && row.status === 'active' ? (
            <StatusBadge tone="warning">{u('users.twoFactorMissing')}</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">{u('users.twoFactorOff')}</StatusBadge>
          );
          const note =
            row.twoFactorRequired && (row.twoFactorEnabled || row.status !== 'active')
              ? u('users.twoFactorRequiredNote')
              : !row.twoFactorRequired
                ? u('users.twoFactorOptionalNote')
                : null;
          return (
            <div className="space-y-0.5">
              {badge}
              {note === null ? null : <p className="text-xs text-muted-foreground">{note}</p>}
            </div>
          );
        },
      }),
      column.accessor('lastSignInAt', {
        header: u('users.colLastSignIn'),
        cell: (cell) => {
          const value = cell.getValue();
          return value === null ? (
            <span className="text-muted-foreground">{u('users.never')}</span>
          ) : (
            <DateTime value={value} />
          );
        },
      }),
      column.display({
        id: 'actions',
        header: u('users.colActions'),
        cell: (cell) => {
          const row = cell.row.original;
          const removal = row.superAdminRemoval;
          return (
            <div className="flex flex-wrap items-center gap-2">
              {/* A super admin with no role here, or an owner, is listed but managed elsewhere. */}
              <PermissionGate allowed={mayChange && row.hasRoleHere}>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`${u('users.manage')}: ${row.name}`}
                  onClick={() => {
                    setNotice(null);
                    setManageId(row.userId);
                  }}
                >
                  {u('users.manage')}
                </Button>
              </PermissionGate>
              {removal === null || !mayChange ? null : (
                <RemovalActions
                  row={row}
                  removal={removal}
                  onPick={(kind) => {
                    setNotice(null);
                    setRemoving({ kind, row, removal });
                  }}
                />
              )}
            </div>
          );
        },
      }),
    ]) as readonly DataTableColumn<StaffRow>[];
  }, [u, branches, mayChange, locale, tel, extensions, showExtensions]);

  if (!mayRead) {
    return (
      <PermissionGate
        allowed={false}
        explain={{ title: u('users.deniedTitle'), detail: u('users.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={u('users.title')}
        description={u('users.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Only the first super admin (or an owner) adds a super admin (D-659, D-666). */}
            <PermissionGate
              allowed={mayInvite && isSuperAdmin && staffQuery.data?.canStartSuperAdmin === true}
            >
              <Button variant="outline" onClick={() => setInviteOpen('superAdmin')}>
                <Crown aria-hidden="true" />
                {u('users.inviteSuperAdmin')}
              </Button>
            </PermissionGate>
            <PermissionGate allowed={mayInvite}>
              <Button onClick={() => setInviteOpen('staff')}>
                <UserPlus aria-hidden="true" />
                {u('users.invite')}
              </Button>
            </PermissionGate>
          </div>
        }
      />

      <p role="status" aria-live="polite" className={notice === null ? 'sr-only' : NOTICE}>
        {notice ?? ''}
      </p>

      {resets.length === 0 ? null : (
        <WaitingResets
          resets={resets}
          nameOf={nameOf}
          onIssued={(issued) => setLink(issued)}
          onDone={async (message) => {
            setNotice(message === '' ? null : message);
            await refresh();
          }}
        />
      )}

      <DataTable<StaffRow>
        caption={u('users.caption')}
        columns={columns}
        data={items}
        getRowId={(row) => row.userId}
        loading={staffQuery.isPending}
        error={staffQuery.error}
        onRetry={() => void staffQuery.refetch()}
        page={SINGLE_PAGE}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        labels={{
          columns: t('table.columns'),
          previous: t('table.previous'),
          next: t('table.next'),
          emptyTitle: u('users.emptyTitle'),
          emptyDetail: u('users.emptyDetail'),
          errorTitle: t('table.errorTitle'),
          errorDetail: t('table.errorDetail'),
          retry: t('common.retry'),
          pageStatus: `${t('table.page')} 1`,
          sortAscending: t('table.sortAscending'),
          sortDescending: t('table.sortDescending'),
        }}
      />

      {managed === null ? null : (
        <ManageDialog
          // Remounted when the roles change underneath it, so the editor starts from them.
          key={`${managed.userId}:${JSON.stringify(managed.roles)}`}
          row={managed}
          branches={branches}
          actorIsSuperAdmin={isSuperAdmin}
          onClose={() => setManageId(null)}
          onAction={(action) => {
            // One modal at a time: the reason dialog replaces this one.
            setManageId(null);
            setPending({ action, row: managed });
          }}
          onSignOut={() => {
            setManageId(null);
            setSigningOut(managed);
          }}
          onSaved={async () => {
            setNotice(u('users.rolesSaved'));
            await refresh();
          }}
          onNotice={async (message) => {
            setNotice(message);
            await refresh();
          }}
        />
      )}

      {pending === null ? null : (
        <ReasonDialog
          key={`${pending.action}:${pending.row.userId}`}
          pending={pending}
          onClose={() => setPending(null)}
          onDone={async (result) => {
            setPending(null);
            if (result.link !== undefined) {
              setManageId(null);
              setLink(result.link);
            }
            setNotice(result.message === '' ? null : result.message);
            await refresh();
          }}
        />
      )}

      {inviteOpen === null ? null : (
        <InviteDialog
          branches={branches}
          superAdmin={inviteOpen === 'superAdmin'}
          onClose={() => setInviteOpen(null)}
          onInvited={async (result) => {
            setInviteOpen(null);
            if (result.nomination !== undefined) {
              setNotice(nominationNotice(result.nomination, result.name, u));
            } else if (result.link === null) {
              setNotice(u('users.alreadyHasAccount'));
            }
            if (result.link !== null) setLink(result.link);
            await refresh();
          }}
        />
      )}

      {link === null ? null : (
        <LinkDialog key={link.token} link={link} onClose={() => setLink(null)} />
      )}

      {/* Sign a person out everywhere (M40, D-696): no reason asked, nothing else changes. */}
      <ConfirmDialog
        open={signingOut !== null}
        onOpenChange={(open) => {
          if (!open) setSigningOut(null);
        }}
        title={u('users.signOutEverywhereTitle').replace(
          '{name}',
          signingOut === null ? '' : displayName(signingOut, u),
        )}
        description={u('users.signOutEverywhereDetail')}
        confirmLabel={u('users.signOutEverywhere')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        destructive
        onConfirm={async () => {
          if (signingOut === null) return;
          try {
            await signOutEverywhere(signingOut.userId);
            setNotice(u('users.signedOutEverywhere').replace('{name}', displayName(signingOut, u)));
          } catch (cause) {
            setNotice(messageOf(cause, t('error.unreachable')));
          }
          await refresh();
        }}
      />

      <RemovalConfirm
        removing={removing}
        onClose={() => setRemoving(null)}
        onDone={async (message) => {
          setRemoving(null);
          setNotice(message);
          await refresh();
        }}
      />
    </div>
  );
}

// --- removing a super admin, and stepping down (D-685, D-686) ------------------------------

function RemovalActions({
  row,
  removal,
  onPick,
}: {
  readonly row: StaffRow;
  readonly removal: RemovalView;
  readonly onPick: (kind: 'stepDown' | 'remove' | 'withdraw') => void;
}) {
  const u = useUsersT();
  const name = displayName(row, u);
  const voteLabel = removal.pending ? u('users.removalVote') : u('users.removalStart');
  return (
    <>
      {removal.canStepDown ? (
        <Button variant="outline" size="sm" onClick={() => onPick('stepDown')}>
          <ShieldMinus aria-hidden="true" />
          {u('users.stepDown')}
        </Button>
      ) : null}
      {removal.canVote ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={`${voteLabel}: ${name}`}
          onClick={() => onPick('remove')}
        >
          <ShieldMinus aria-hidden="true" />
          {voteLabel}
        </Button>
      ) : null}
      {removal.canWithdraw ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={`${u('users.removalWithdraw')}: ${name}`}
          onClick={() => onPick('withdraw')}
        >
          <X aria-hidden="true" />
          {u('users.removalWithdraw')}
        </Button>
      ) : null}
    </>
  );
}

function RemovalConfirm({
  removing,
  onClose,
  onDone,
}: {
  readonly removing: Removing;
  readonly onClose: () => void;
  readonly onDone: (message: string) => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const { locale } = useLocale();

  let text = { title: '', detail: '', confirm: '' };
  if (removing !== null) {
    const name = displayName(removing.row, u);
    if (removing.kind === 'stepDown') {
      text = {
        title: u('users.stepDownTitle'),
        detail: u('users.stepDownDetail'),
        confirm: u('users.stepDown'),
      };
    } else if (removing.kind === 'withdraw') {
      text = {
        title: u('users.removalWithdrawTitle').replace('{name}', name),
        detail: u('users.removalWithdrawDetail'),
        confirm: u('users.removalWithdraw'),
      };
    } else {
      const { pending, immediate, needed } = removing.removal;
      text = {
        title: (pending ? u('users.removalVoteTitle') : u('users.removalTitle')).replace(
          '{name}',
          name,
        ),
        detail: immediate
          ? u('users.removalImmediate')
          : u('users.removalRule').replace('{m}', formatCount(needed, locale)),
        confirm: pending ? u('users.removalVote') : u('users.removalStart'),
      };
    }
  }

  const confirm = async (current: NonNullable<Removing>) => {
    const name = displayName(current.row, u);
    try {
      if (current.kind === 'stepDown') {
        await stepDown();
        // Every session ended, this one included: a full reload lands on sign-in with no
        // cached query, socket or ability left from the super admin's view.
        window.location.reload();
        return;
      }
      if (current.kind === 'withdraw') {
        await withdrawSuperAdminRemoval(current.row.userId);
        await onDone(u('users.removalWithdrawn'));
        return;
      }
      const result = await voteSuperAdminRemoval(current.row.userId);
      const done =
        result.outcome === 'removed' ? u('users.removalDone') : u('users.removalWaiting');
      await onDone(done.replace('{name}', name));
    } catch (cause) {
      await onDone(messageOf(cause, t('error.unreachable')));
    }
  };

  return (
    <ConfirmDialog
      open={removing !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      destructive={removing?.kind !== 'withdraw'}
      title={text.title}
      description={text.detail}
      confirmLabel={text.confirm}
      cancelLabel={t('common.cancel')}
      closeLabel={t('common.close')}
      onConfirm={() => (removing === null ? undefined : confirm(removing))}
    />
  );
}

const NOTICE = 'rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground';

// --- resets waiting for a second admin ------------------------------------------------

function WaitingResets({
  resets,
  nameOf,
  onIssued,
  onDone,
}: {
  readonly resets: readonly OpenReset[];
  readonly nameOf: (userId: string) => string;
  readonly onIssued: (link: IssuedLink) => void;
  readonly onDone: (message: string) => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const session = useSession();
  const me = session.context?.userId ?? '';
  const [deciding, setDeciding] = useState<{
    reset: OpenReset;
    decision: 'approved' | 'rejected';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const collect = useMutation({
    mutationFn: (reset: OpenReset) => passwordLink(reset.userId, reset.reason),
    onSuccess: (result, reset) => {
      if (result.outcome === 'issued') {
        onIssued({
          name: nameOf(reset.userId),
          kind: result.kind,
          token: result.token,
          expiresAt: result.expiresAt,
        });
      }
      void onDone('');
    },
    onError: (cause) => setError(messageOf(cause, t('error.unreachable'))),
  });

  return (
    <section aria-labelledby="resets-heading" className="space-y-3">
      <div>
        <h2 id="resets-heading" className="text-sm font-medium">
          {u('users.waitingHeading')}
        </h2>
        <p className="text-xs text-muted-foreground">{u('users.waitingDetail')}</p>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {resets.map((reset) => {
          const kind =
            reset.kind === 'password'
              ? u('users.resetKindPassword')
              : u('users.resetKindTwoFactor');
          const aboutMe = reset.userId === me;
          let state: ReactNode;
          if (reset.status === 'pending_approval') {
            if (aboutMe) state = <Muted>{u('users.aboutYou')}</Muted>;
            else if (reset.mine) state = <Muted>{u('users.waitingForSecond')}</Muted>;
            else
              state = (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setDeciding({ reset, decision: 'approved' })}>
                    {u('users.approve')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeciding({ reset, decision: 'rejected' })}
                  >
                    {u('users.reject')}
                  </Button>
                </div>
              );
          } else if (reset.mine) {
            state = (
              <div className="space-y-2">
                <Muted>{u('users.approvedCollect')}</Muted>
                <Button
                  size="sm"
                  disabled={collect.isPending}
                  onClick={() => collect.mutate(reset)}
                >
                  <KeyRound aria-hidden="true" />
                  {u('users.getLink')}
                </Button>
              </div>
            );
          } else {
            state = <Muted>{u('users.approvedOther')}</Muted>;
          }
          return (
            <li key={reset.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">
                  {kind}: {nameOf(reset.userId)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {u('users.askedBy')}:{' '}
                  {reset.requestedByName ??
                    (reset.requestedByOwner === true
                      ? u('users.owner')
                      : nameOf(reset.requestedBy))}{' '}
                  · <DateTime value={reset.createdAt} />
                </p>
                <p className="text-xs text-muted-foreground">
                  {u('users.reason')}: {reset.reason}
                </p>
              </div>
              {state}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={deciding !== null}
        onOpenChange={(open) => {
          if (!open) setDeciding(null);
        }}
        destructive={deciding?.decision === 'rejected'}
        title={
          deciding === null
            ? ''
            : `${deciding.decision === 'approved' ? u('users.approve') : u('users.reject')}: ${
                deciding.reset.kind === 'password'
                  ? u('users.resetKindPassword')
                  : u('users.resetKindTwoFactor')
              }`
        }
        description={deciding === null ? '' : nameOf(deciding.reset.userId)}
        confirmLabel={deciding?.decision === 'rejected' ? u('users.reject') : u('users.approve')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        onConfirm={async () => {
          const approvalId = deciding?.reset.approvalRequestId ?? null;
          if (deciding === null || approvalId === null) return;
          setError(null);
          try {
            await decideApproval(approvalId, deciding.decision);
            setDeciding(null);
            await onDone('');
          } catch (cause) {
            setDeciding(null);
            setError(messageOf(cause, t('error.unreachable')));
          }
        }}
      >
        {deciding === null ? null : (
          <p className="text-sm text-muted-foreground">
            {u('users.reason')}: {deciding.reset.reason}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}

function Muted({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

// --- managing one person ----------------------------------------------------------------

function ManageDialog({
  row,
  branches,
  actorIsSuperAdmin,
  onClose,
  onAction,
  onSignOut,
  onSaved,
  onNotice,
}: {
  readonly row: StaffRow;
  readonly branches: readonly BranchRow[];
  readonly actorIsSuperAdmin: boolean;
  readonly onClose: () => void;
  readonly onAction: (action: Action) => void;
  /** Sign this person out everywhere (M40): the page asks for confirmation. */
  readonly onSignOut: () => void;
  readonly onSaved: () => Promise<void>;
  readonly onNotice: (message: string) => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const [ticked, setTicked] = useState<Map<MembershipRole, string[]>>(
    () => new Map(row.roles.map((grant) => [grant.role, [...grant.branchIds]])),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const locked = row.isSelf || (row.isSuperAdmin && !actorIsSuperAdmin);
  const resetLocked =
    locked ||
    (row.status !== 'active' && row.status !== 'invited') ||
    (row.inOtherBrand && !actorIsSuperAdmin);

  const save = useMutation({
    mutationFn: (roles: Parameters<typeof setRoles>[1]) => setRoles(row.userId, roles),
    onSuccess: async () => {
      setProblem(null);
      await onSaved();
    },
    onError: (cause) => setProblem(messageOf(cause, t('error.unreachable'))),
  });

  const note: UsersMessageKey | null = row.isSelf
    ? 'users.selfNote'
    : row.isSuperAdmin && !actorIsSuperAdmin
      ? 'users.protectedNote'
      : row.status === 'deactivated'
        ? 'users.deactivatedNote'
        : row.inOtherBrand && !actorIsSuperAdmin
          ? 'users.otherBrandNote'
          : null;

  const toggleRole = (role: MembershipRole, on: boolean) => {
    setTicked((current) => {
      const next = new Map(current);
      if (on) next.set(role, current.get(role) ?? []);
      else next.delete(role);
      return next;
    });
  };
  const toggleBranch = (role: MembershipRole, branchId: string, on: boolean) => {
    setTicked((current) => {
      const next = new Map(current);
      const list = new Set(current.get(role) ?? []);
      if (on) list.add(branchId);
      else list.delete(branchId);
      next.set(role, [...list]);
      return next;
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${u('users.manageTitle')}: ${row.name}`}
      description={u('users.manageDetail')}
      closeLabel={t('common.close')}
      className="w-[min(40rem,calc(100vw-2rem))]"
    >
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">{row.email}</p>
        {note === null ? null : (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{u(note)}</p>
        )}

        <section aria-labelledby="roles-heading" className="space-y-3">
          <div>
            <h3 id="roles-heading" className="text-sm font-medium">
              {u('users.rolesHeading')}
            </h3>
            <p className="text-xs text-muted-foreground">{u('users.rolesHint')}</p>
          </div>
          <fieldset disabled={locked} className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">{u('users.rolesHeading')}</legend>
            {orderedRoles().map((role) => {
              const on = ticked.has(role);
              const chosen = ticked.get(role) ?? [];
              return (
                <div key={role} className="rounded-md border border-border p-2.5">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      checked={on}
                      onChange={(event) => toggleRole(role, event.target.checked)}
                    />
                    {u(roleKey(role))}
                  </label>
                  {on && branches.length > 0 ? (
                    <details className="mt-2" open={role === 'branch_manager' || chosen.length > 0}>
                      <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                        {u('users.limitToBranches')}
                        {chosen.length === 0
                          ? ` · ${u('users.wholeOrg')}`
                          : ` · ${String(chosen.length)}`}
                      </summary>
                      <div className="mt-1.5 space-y-1">
                        {branches.map((branch) => (
                          <label
                            key={branch.id}
                            className="flex cursor-pointer items-center gap-2 text-xs"
                          >
                            <input
                              type="checkbox"
                              className={CHECKBOX}
                              checked={chosen.includes(branch.id)}
                              onChange={(event) =>
                                toggleBranch(role, branch.id, event.target.checked)
                              }
                            />
                            {branch.code} · {branch.name}
                          </label>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
          {problem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <Button
            size="sm"
            disabled={locked || save.isPending}
            onClick={() => {
              const submitted = rolesToSubmit(ticked);
              if (submitted.problem === 'none') return setProblem(u('users.needOneRole'));
              if (submitted.problem === 'branch') return setProblem(u('users.needBranch'));
              save.mutate(submitted.roles);
            }}
          >
            {save.isPending ? u('users.saving') : u('users.saveRoles')}
          </Button>
        </section>

        <section aria-labelledby="signin-heading" className="space-y-3">
          <h3 id="signin-heading" className="text-sm font-medium">
            {u('users.signInHeading')}
          </h3>
          {row.resetNeedsApproval && !resetLocked ? (
            <p className="text-xs text-muted-foreground">{u('users.needsApprovalNote')}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {row.hasPassword ? (
              <Button
                size="sm"
                variant="outline"
                disabled={resetLocked}
                onClick={() => onAction('password')}
              >
                <KeyRound aria-hidden="true" />
                {u('users.resetPassword')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={resetLocked}
                onClick={() => onAction('invite')}
              >
                <KeyRound aria-hidden="true" />
                {u('users.sendInvite')}
              </Button>
            )}
            {row.twoFactorEnabled ? (
              <Button
                size="sm"
                variant="outline"
                disabled={resetLocked}
                onClick={() => onAction('twoFactor')}
              >
                <ShieldOff aria-hidden="true" />
                {u('users.resetTwoFactor')}
              </Button>
            ) : null}
            {/* Off for good only where nothing requires it (M40, D-697). */}
            {row.twoFactorEnabled && !row.twoFactorRequired ? (
              <Button
                size="sm"
                variant="outline"
                disabled={resetLocked}
                onClick={() => onAction('turnOff')}
              >
                <ShieldX aria-hidden="true" />
                {u('users.turnOffTwoFactor')}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={locked} onClick={onSignOut}>
              <LogOut aria-hidden="true" />
              {u('users.signOutEverywhere')}
            </Button>
          </div>
          {row.twoFactorEnabled && row.twoFactorRequired && !resetLocked ? (
            <p className="text-xs text-muted-foreground">{u('users.twoFactorRequiredReset')}</p>
          ) : null}
        </section>

        {row.trust === null ? null : <TrustSection row={row} trust={row.trust} onSaved={onSaved} />}

        {/* M41 (D-714): what this person may be offered, and the hub they pack at. */}
        {row.status === 'active' ? <DeskSection userId={row.userId} locked={locked} /> : null}

        {row.superAdminNomination === null ? null : (
          <SuperAdminSection row={row} nomination={row.superAdminNomination} onNotice={onNotice} />
        )}

        {row.status === 'active' || row.status === 'invited' ? (
          <section className="border-t border-border pt-4">
            <Button
              size="sm"
              variant="destructive"
              disabled={locked}
              onClick={() => onAction('deactivate')}
            >
              <UserMinus aria-hidden="true" />
              {u('users.deactivate')}
            </Button>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- trust votes (D-654 to D-656) ---------------------------------------------------------

function TrustSection({
  row,
  trust,
  onSaved,
}: {
  readonly row: StaffRow;
  readonly trust: TrustView;
  readonly onSaved: () => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const { locale } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => (trust.votedByMe ? withdrawTrust(row.userId) : voteTrust(row.userId)),
    onSuccess: async () => {
      setProblem(null);
      await onSaved();
    },
    onError: (cause) => setProblem(messageOf(cause, t('error.unreachable'))),
  });

  return (
    <section aria-labelledby="trust-heading" className="space-y-3">
      <div>
        <h3 id="trust-heading" className="flex items-center gap-2 text-sm font-medium">
          {u('users.trustHeading')}
          <StatusBadge tone={trust.trusted ? 'success' : 'neutral'}>
            {trustLabel(trust, u, locale)}
          </StatusBadge>
        </h3>
        <p className="text-xs text-muted-foreground">{u('users.trustExplain')}</p>
        <p className="text-xs text-muted-foreground">{u('users.trustRule')}</p>
      </div>
      {row.isSelf ? null : (
        <div className="space-y-2">
          {trust.votedByMe ? (
            <Button
              size="sm"
              variant="outline"
              disabled={change.isPending}
              onClick={() => change.mutate()}
            >
              <ShieldX aria-hidden="true" />
              {u('users.trustWithdraw')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!trust.canVote || change.isPending}
              aria-describedby={trust.canVote ? undefined : 'trust-reason'}
              onClick={() => change.mutate()}
            >
              <ShieldCheck aria-hidden="true" />
              {u('users.trustVote')}
            </Button>
          )}
          {!trust.canVote && trust.reasonCode !== null && !trust.votedByMe ? (
            <p id="trust-reason" className="text-xs text-muted-foreground">
              {u(`users.trustReason.${trust.reasonCode}`)}
            </p>
          ) : null}
          {problem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// --- super admins making super admins (D-659) -------------------------------------------

function SuperAdminSection({
  row,
  nomination,
  onNotice,
}: {
  readonly row: StaffRow;
  readonly nomination: NominationView;
  readonly onNotice: (message: string) => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const { locale } = useLocale();
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const vote = useMutation({
    mutationFn: () => voteSuperAdmin(row.userId),
    onSuccess: async (result) => {
      setProblem(null);
      setConfirming(false);
      await onNotice(nominationNotice(result, row.name, u));
    },
    onError: (cause) => {
      setConfirming(false);
      setProblem(messageOf(cause, t('error.unreachable')));
    },
  });
  const withdraw = useMutation({
    mutationFn: () => withdrawSuperAdmin(row.userId),
    onSuccess: async () => {
      setProblem(null);
      await onNotice(u('users.superAdminWithdrawn'));
    },
    onError: (cause) => setProblem(messageOf(cause, t('error.unreachable'))),
  });
  const busy = vote.isPending || withdraw.isPending;
  const rule = nomination.immediate
    ? u('users.superAdminImmediate')
    : u('users.superAdminRule').replace('{m}', formatCount(nomination.needed, locale));
  const actionLabel = nomination.pending ? u('users.superAdminVote') : u('users.superAdminMake');

  return (
    <section aria-labelledby="super-admin-heading" className="space-y-3">
      <div>
        <h3 id="super-admin-heading" className="flex items-center gap-2 text-sm font-medium">
          {u('users.superAdminHeading')}
          {nomination.pending ? (
            <StatusBadge tone="warning">{nominationLabel(nomination, u, locale)}</StatusBadge>
          ) : null}
        </h3>
        <p className="text-xs text-muted-foreground">{u('users.superAdminExplain')}</p>
        <p className="text-xs text-muted-foreground">{rule}</p>
      </div>
      {confirming ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-medium">
            {u('users.superAdminConfirm').replace('{name}', row.name)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => vote.mutate()}>
              <Crown aria-hidden="true" />
              {actionLabel}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {nomination.canVote ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
              <Crown aria-hidden="true" />
              {actionLabel}
            </Button>
          ) : null}
          {nomination.canWithdraw ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => withdraw.mutate()}>
              <X aria-hidden="true" />
              {u('users.superAdminWithdraw')}
            </Button>
          ) : null}
        </div>
      )}
      {nomination.votedByMe && !nomination.canVote ? (
        <Muted>{u('users.superAdminVoted')}</Muted>
      ) : null}
      {!nomination.canVote && !nomination.canWithdraw && !nomination.votedByMe ? (
        <Muted>{u('users.superAdminOnlyNote')}</Muted>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}

// --- the reason, then the action ---------------------------------------------------------

const ACTION_TEXT: Record<
  Action,
  { title: UsersMessageKey; detail: UsersMessageKey; confirm: UsersMessageKey }
> = {
  turnOff: {
    title: 'users.turnOffTitle',
    detail: 'users.turnOffDetail',
    confirm: 'users.turnOffTwoFactor',
  },
  deactivate: {
    title: 'users.deactivateTitle',
    detail: 'users.deactivateDetail',
    confirm: 'users.deactivate',
  },
  password: {
    title: 'users.passwordTitle',
    detail: 'users.passwordDetail',
    confirm: 'users.confirmReset',
  },
  invite: {
    title: 'users.inviteAgainTitle',
    detail: 'users.inviteAgainDetail',
    confirm: 'users.confirmLink',
  },
  twoFactor: {
    title: 'users.twoFactorTitle',
    detail: 'users.twoFactorDetail',
    confirm: 'users.confirmReset',
  },
};

function ReasonDialog({
  pending,
  onClose,
  onDone,
}: {
  readonly pending: NonNullable<Pending>;
  readonly onClose: () => void;
  readonly onDone: (result: { message: string; link?: IssuedLink }) => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const text = ACTION_TEXT[pending.action];
  const reasonRequired = pending.action !== 'deactivate';

  const confirm = async () => {
    if (reasonRequired && reason.trim().length < 3) {
      setError(u('users.reasonRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { row } = pending;
      if (pending.action === 'deactivate') {
        await deactivate(row.userId, reason.trim());
        await onDone({ message: u('users.deactivatedDone') });
      } else if (pending.action === 'twoFactor') {
        const result = await resetTwoFactor(row.userId, reason.trim());
        await onDone({
          message:
            result.outcome === 'completed' ? u('users.twoFactorDone') : u('users.pendingNotice'),
        });
      } else if (pending.action === 'turnOff') {
        const result = await turnOffTwoFactor(row.userId, reason.trim());
        await onDone({
          message: result.outcome === 'completed' ? u('users.turnedOff') : u('users.pendingNotice'),
        });
      } else {
        const result = await passwordLink(row.userId, reason.trim());
        if (result.outcome === 'issued') {
          await onDone({
            message: '',
            link: {
              name: row.name,
              kind: result.kind,
              token: result.token,
              expiresAt: result.expiresAt,
            },
          });
        } else {
          await onDone({ message: u('users.pendingNotice') });
        }
      }
    } catch (cause) {
      setError(messageOf(cause, t('error.unreachable')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={u(text.title)}
      description={u(text.detail)}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={pending.action === 'deactivate' ? 'destructive' : 'primary'}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {u(text.confirm)}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm font-medium">{pending.row.name}</p>
        {pending.row.resetNeedsApproval &&
        pending.action !== 'deactivate' &&
        pending.action !== 'invite' ? (
          <p className="text-xs text-muted-foreground">{u('users.needsApprovalNote')}</p>
        ) : null}
        <Field
          label={u('users.fieldReason')}
          name="reason"
          id="reset-reason"
          hint={u('users.reasonHint')}
          value={reason}
          maxLength={300}
          onChange={(event) => setReason(event.target.value)}
          error={error ?? undefined}
        />
      </div>
    </Dialog>
  );
}

// --- the link ------------------------------------------------------------------------------

function LinkDialog({
  link,
  onClose,
}: {
  readonly link: IssuedLink;
  readonly onClose: () => void;
}) {
  const u = useUsersT();
  const t = useT();
  const [copied, setCopied] = useState(false);

  const url = passwordLinkUrl(window.location.origin, link.kind, link.token);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${u('users.linkTitle')}: ${link.name}`}
      description={u('users.linkDetail')}
      closeLabel={t('common.close')}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="issued-link" className="block text-sm font-medium">
            {u('users.linkLabel')}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="issued-link"
              readOnly
              value={url}
              onFocus={(event) => event.target.select()}
              className="h-control min-w-0 flex-1 rounded-md border border-input bg-muted px-3 font-mono text-xs text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => setCopied(true));
              }}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? u('users.copied') : u('users.copyLink')}
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {u('users.linkExpires')}: <DateTime value={link.expiresAt} />
        </p>
      </div>
    </Dialog>
  );
}

// --- inviting -------------------------------------------------------------------------------

function InviteDialog({
  branches,
  superAdmin,
  onClose,
  onInvited,
}: {
  readonly branches: readonly BranchRow[];
  /** Invite a super admin (D-659): an admin of the whole brand, nominated in the same step. */
  readonly superAdmin: boolean;
  readonly onClose: () => void;
  readonly onInvited: (result: {
    link: IssuedLink | null;
    name: string;
    nomination?: NominationOutcome;
  }) => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<MembershipRole | ''>(superAdmin ? 'org_admin' : '');
  const [chosen, setChosen] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ email?: string; name?: string; role?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = u('users.invalidEmail');
    if (name.trim() === '') next.name = u('users.nameRequired');
    if (role === '') next.role = u('users.pickRole');
    else if (role === 'branch_manager' && chosen.length === 0) next.role = u('users.needBranch');
    setErrors(next);
    if (Object.keys(next).length > 0 || role === '') return;

    setBusy(true);
    setFailure(null);
    try {
      const result = await invite({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        role,
        branchIds: superAdmin ? [] : chosen,
        ...(superAdmin ? { superAdmin: true } : {}),
      });
      await onInvited({
        name: name.trim(),
        ...(result.superAdmin === undefined ? {} : { nomination: result.superAdmin }),
        link:
          result.inviteToken === undefined
            ? null
            : {
                name: name.trim(),
                kind: 'invite',
                token: result.inviteToken,
                expiresAt: result.inviteExpiresAt ?? new Date().toISOString(),
              },
      });
    } catch (cause) {
      setFailure(messageOf(cause, t('error.unreachable')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={superAdmin ? u('users.inviteSuperAdmin') : u('users.inviteTitle')}
      description={superAdmin ? u('users.inviteSuperAdminDetail') : u('users.inviteDetail')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {u('users.inviteSubmit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {failure === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <Field
          label={u('users.fieldEmail')}
          id="invite-email"
          name="email"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
        />
        <Field
          label={u('users.fieldName')}
          id="invite-name"
          name="name"
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
        />
        {superAdmin ? null : (
          <div className="space-y-1.5">
            <label htmlFor="invite-role" className="block text-sm font-medium">
              {u('users.fieldRole')}
            </label>
            <Select
              id="invite-role"
              value={role}
              placeholder={u('users.pickRole')}
              aria-invalid={errors.role === undefined ? undefined : true}
              aria-describedby={errors.role === undefined ? undefined : 'invite-role-error'}
              onValueChange={(value) => setRole(value as MembershipRole | '')}
              options={orderedRoles().map((option) => ({
                value: option,
                label: u(roleKey(option)),
              }))}
            />
            {errors.role === undefined ? null : (
              <p id="invite-role-error" className="text-xs text-destructive">
                {errors.role}
              </p>
            )}
          </div>
        )}
        {!superAdmin && role !== '' && branches.length > 0 ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{u('users.branches')}</legend>
            <p className="text-xs text-muted-foreground">
              {role === 'branch_manager' ? u('users.needBranch') : u('users.wholeOrg')}
            </p>
            {branches.map((branch) => (
              <label key={branch.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={chosen.includes(branch.id)}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked
                        ? [...current, branch.id]
                        : current.filter((id) => id !== branch.id),
                    )
                  }
                />
                {branch.code} · {branch.name}
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
    </Dialog>
  );
}
