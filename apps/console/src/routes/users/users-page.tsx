import type { MembershipRole } from '@elysium/contracts';
import {
  Button,
  ConfirmDialog,
  DataTable,
  DateTime,
  Dialog,
  PermissionGate,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, ShieldOff, UserMinus, UserPlus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { decideApproval } from '../../api/approvals.js';
import { useAbility, useSession } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { Field } from '../../ui/primitives.js';
import { listBranches, type BranchRow } from '../branches/api.js';
import {
  deactivate,
  invite,
  listStaff,
  passwordLink,
  resetTwoFactor,
  setRoles,
  type OpenReset,
  type StaffRow,
  type StaffStatus,
} from './api.js';
import { orderedRoles, passwordLinkUrl, rolesToSubmit } from './link.js';
import { useUsersT, type UsersMessageKey } from './messages.js';

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
const SELECT =
  'h-control w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

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

/** The server's problem+json detail is written to be shown; anything else never reached it. */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

type Pending = {
  readonly action: 'deactivate' | 'password' | 'invite' | 'twoFactor';
  readonly row: StaffRow;
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
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'User');
  const mayChange = ability.can('update', 'User');
  const mayInvite = ability.can('create', 'User');
  const isSuperAdmin = session.context?.isSuperAdmin ?? false;

  const [manageId, setManageId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [link, setLink] = useState<IssuedLink | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const staffQuery = useQuery({ queryKey: ['users'], queryFn: listStaff, enabled: mayRead });
  const branchesQuery = useQuery({
    queryKey: ['users', 'branches'],
    queryFn: listBranches,
    enabled: mayChange && ability.can('read', 'LedgerReport'),
  });
  const branches = useMemo(() => branchesQuery.data?.items ?? [], [branchesQuery.data]);

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
  const nameOf = (userId: string) => items.find((row) => row.userId === userId)?.name ?? userId;

  const columns = useMemo<readonly DataTableColumn<StaffRow>[]>(() => {
    const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? id;
    const column = dataTableColumns<StaffRow>();
    return column.columns([
      column.accessor('name', {
        header: u('users.colName'),
        cell: (cell) => {
          const row = cell.row.original;
          return (
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 font-medium">
                {row.name}
                {row.isSelf ? <StatusBadge tone="neutral">{u('users.you')}</StatusBadge> : null}
                {row.isSuperAdmin ? (
                  <StatusBadge tone="info">{u('users.superAdmin')}</StatusBadge>
                ) : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">{row.email}</p>
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
          if (row.twoFactorEnabled) {
            return <StatusBadge tone="success">{u('users.twoFactorOn')}</StatusBadge>;
          }
          if (row.twoFactorRequired && row.status === 'active') {
            return <StatusBadge tone="warning">{u('users.twoFactorMissing')}</StatusBadge>;
          }
          return <StatusBadge tone="neutral">{u('users.twoFactorOff')}</StatusBadge>;
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
        cell: (cell) => (
          <PermissionGate allowed={mayChange}>
            <Button
              variant="outline"
              size="sm"
              aria-label={`${u('users.manage')}: ${cell.row.original.name}`}
              onClick={() => {
                setNotice(null);
                setManageId(cell.row.original.userId);
              }}
            >
              {u('users.manage')}
            </Button>
          </PermissionGate>
        ),
      }),
    ]) as readonly DataTableColumn<StaffRow>[];
  }, [u, branches, mayChange]);

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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{u('users.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{u('users.subtitle')}</p>
        </div>
        <PermissionGate allowed={mayInvite}>
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus aria-hidden="true" />
            {u('users.invite')}
          </Button>
        </PermissionGate>
      </header>

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
          onSaved={async () => {
            setNotice(u('users.rolesSaved'));
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

      {inviteOpen ? (
        <InviteDialog
          branches={branches}
          onClose={() => setInviteOpen(false)}
          onInvited={async (result) => {
            setInviteOpen(false);
            if (result.link === null) setNotice(u('users.alreadyHasAccount'));
            else setLink(result.link);
            await refresh();
          }}
        />
      ) : null}

      {link === null ? null : (
        <LinkDialog key={link.token} link={link} onClose={() => setLink(null)} />
      )}
    </div>
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
                  {u('users.askedBy')}: {reset.requestedByName ?? reset.requestedBy} ·{' '}
                  <DateTime value={reset.createdAt} />
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
  onSaved,
}: {
  readonly row: StaffRow;
  readonly branches: readonly BranchRow[];
  readonly actorIsSuperAdmin: boolean;
  readonly onClose: () => void;
  readonly onAction: (action: 'deactivate' | 'password' | 'invite' | 'twoFactor') => void;
  readonly onSaved: () => Promise<void>;
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
          </div>
        </section>

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

// --- the reason, then the action ---------------------------------------------------------

const ACTION_TEXT: Record<
  'deactivate' | 'password' | 'invite' | 'twoFactor',
  { title: UsersMessageKey; detail: UsersMessageKey; confirm: UsersMessageKey }
> = {
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
  onClose,
  onInvited,
}: {
  readonly branches: readonly BranchRow[];
  readonly onClose: () => void;
  readonly onInvited: (result: { link: IssuedLink | null }) => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<MembershipRole | ''>('');
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
        branchIds: chosen,
      });
      await onInvited({
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
      title={u('users.inviteTitle')}
      description={u('users.inviteDetail')}
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
        <div className="space-y-1.5">
          <label htmlFor="invite-role" className="block text-sm font-medium">
            {u('users.fieldRole')}
          </label>
          <select
            id="invite-role"
            className={SELECT}
            value={role}
            aria-invalid={errors.role === undefined ? undefined : true}
            aria-describedby={errors.role === undefined ? undefined : 'invite-role-error'}
            onChange={(event) => setRole(event.target.value as MembershipRole | '')}
          >
            <option value="">{u('users.pickRole')}</option>
            {orderedRoles().map((option) => (
              <option key={option} value={option}>
                {u(roleKey(option))}
              </option>
            ))}
          </select>
          {errors.role === undefined ? null : (
            <p id="invite-role-error" className="text-xs text-destructive">
              {errors.role}
            </p>
          )}
        </div>
        {role !== '' && branches.length > 0 ? (
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
