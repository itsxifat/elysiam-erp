import { Button, ConfirmDialog, DateTime, Dialog, Select } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandHelping, UserCheck, UserRoundX, Users } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiError } from '../../api.js';
import { useAbility, useSession } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import { listAgents, type OrderDetail } from './api.js';
import { assignOrder, releaseOrder, takeOrder } from './workflow-api.js';

/**
 * One person handles each order (M41, D-710 to D-712): the order page's ownership banner and
 * the confirmation every desk action asks for when the order is somebody else's.
 *
 * The server is the gate: without `x-acknowledge-owner` a non-owner's desk write is refused.
 * This is the console's half: before such a write it says who has the order and since when,
 * and only a deliberate "Go ahead" sends the acknowledgement, once, for that one action.
 */

interface Guard {
  /** The order is somebody else's: every desk action asks first. */
  readonly needsAck: boolean;
  /**
   * Run a desk action: at once when the order is free or the caller's, after the confirm
   * dialog otherwise. `run` is told whether to send the acknowledgement.
   */
  readonly guard: (run: (ack: boolean) => void) => void;
}

const GuardContext = createContext<Guard>({ needsAck: false, guard: (run) => run(false) });

export function useOwnerGuard(): Guard {
  return useContext(GuardContext);
}

/** Supervisors reassign anybody's order (D-712). */
function isSupervisor(roles: readonly string[], isSuperAdmin: boolean): boolean {
  return isSuperAdmin || roles.includes('org_admin') || roles.includes('branch_manager');
}

export function OwnerGuardProvider({
  order,
  ownerName,
  children,
}: {
  readonly order: OrderDetail & { readonly assignedAt?: string | null };
  readonly ownerName: string;
  readonly children: ReactNode;
}) {
  const t = useT();
  const session = useSession();
  const me = session.context?.userId ?? '';
  const needsAck = order.assignedTo !== null && order.assignedTo !== me;
  const [pending, setPending] = useState<((ack: boolean) => void) | null>(null);

  const guard = useCallback(
    (run: (ack: boolean) => void) => {
      if (!needsAck) run(false);
      else setPending(() => run);
    },
    [needsAck],
  );
  const value = useMemo(() => ({ needsAck, guard }), [needsAck, guard]);

  return (
    <GuardContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={`${t('wf.own.ackTitle')}: ${ownerName}`}
        description={t('wf.own.ackDetail')}
        confirmLabel={t('wf.own.ackGo')}
        cancelLabel={t('wf.own.ackStop')}
        closeLabel={t('wf.close')}
        onConfirm={() => {
          const run = pending;
          setPending(null);
          run?.(true);
        }}
      >
        {order.assignedAt === null || order.assignedAt === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {t('wf.own.handledBy')} {ownerName} {t('wf.own.since')}{' '}
            <DateTime value={order.assignedAt} />
          </p>
        )}
      </ConfirmDialog>
    </GuardContext.Provider>
  );
}

/**
 * Who has this order, and what you can do about it: take it, release it, hand it over, or (a
 * supervisor) reassign it. Opening the page takes nothing: GETs have no side effects.
 */
export function OwnershipBanner({
  order,
  nameOf,
}: {
  readonly order: OrderDetail & { readonly assignedAt?: string | null };
  readonly nameOf: (userId: string | null) => string;
}) {
  const t = useT();
  const session = useSession();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const me = session.context?.userId ?? '';
  const supervisor = isSupervisor(
    session.context?.roles ?? [],
    session.context?.isSuperAdmin ?? false,
  );
  const mayUpdate = ability.can('update', 'Order');
  const [handing, setHanding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['orders'] });
  const take = useMutation({
    mutationFn: () => takeOrder(order.id),
    onSuccess: () => {
      setProblem(null);
      refresh();
    },
    onError: (error) => {
      setProblem(error instanceof ApiError ? error.message : t('wf.failed'));
      refresh();
    },
  });
  const release = useMutation({
    mutationFn: () => releaseOrder(order.id),
    onSuccess: () => {
      setProblem(null);
      refresh();
    },
    onError: (error) => setProblem(error instanceof ApiError ? error.message : t('wf.failed')),
  });

  if (!mayUpdate && order.assignedTo === null) return null;
  const open = ['pending', 'confirmed', 'on_hold'].includes(order.status);

  const banner =
    order.assignedTo === null ? (
      open ? (
        <section
          aria-labelledby="ownership-title"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4"
          data-testid="ownership-banner"
          data-owner="nobody"
        >
          <div className="flex items-start gap-3">
            <Users aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
            <div>
              <h2 id="ownership-title" className="text-sm font-semibold">
                {t('wf.own.nobody')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('wf.own.nobodyDetail')}</p>
            </div>
          </div>
          {mayUpdate ? (
            <Button size="md" disabled={take.isPending} onClick={() => take.mutate()}>
              <UserCheck aria-hidden="true" />
              {take.isPending ? t('wf.own.taking') : t('wf.own.take')}
            </Button>
          ) : null}
        </section>
      ) : null
    ) : order.assignedTo === me ? (
      <section
        aria-labelledby="ownership-title"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4"
        data-testid="ownership-banner"
        data-owner="me"
      >
        <div className="flex items-start gap-3">
          <UserCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
          <div>
            <h2 id="ownership-title" className="text-sm font-semibold">
              {t('wf.own.yours')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {order.assignedAt === null || order.assignedAt === undefined ? (
                t('wf.own.yoursDetail')
              ) : (
                <>
                  {t('wf.own.since')} <DateTime value={order.assignedAt} />.{' '}
                  {t('wf.own.yoursDetail')}
                </>
              )}
            </p>
          </div>
        </div>
        {mayUpdate ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setHanding(true)}>
              <HandHelping aria-hidden="true" />
              {t('wf.own.handOver')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={release.isPending}
              title={t('wf.own.releaseDetail')}
              onClick={() => release.mutate()}
            >
              <UserRoundX aria-hidden="true" />
              {t('wf.own.release')}
            </Button>
          </div>
        ) : null}
      </section>
    ) : (
      <section
        role="status"
        aria-labelledby="ownership-title"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-warning-subtle p-4 text-warning-subtle-foreground"
        data-testid="ownership-banner"
        data-owner="other"
      >
        <div className="flex items-start gap-3">
          <Users aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div>
            <h2 id="ownership-title" className="text-sm font-semibold">
              {t('wf.own.handledBy')} {nameOf(order.assignedTo)}
              {order.assignedAt === null || order.assignedAt === undefined ? null : (
                <span className="font-normal">
                  {' '}
                  {t('wf.own.since')} <DateTime value={order.assignedAt} />
                </span>
              )}
            </h2>
            <p className="text-sm">{t('wf.own.warn')}</p>
          </div>
        </div>
        {mayUpdate && supervisor ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setHanding(true)}>
              <HandHelping aria-hidden="true" />
              {t('wf.own.reassign')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={release.isPending}
              title={t('wf.own.releaseDetail')}
              onClick={() => release.mutate()}
            >
              <UserRoundX aria-hidden="true" />
              {t('wf.own.release')}
            </Button>
          </div>
        ) : null}
      </section>
    );

  return (
    <>
      {banner}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {handing ? (
        <HandOverDialog
          orderId={order.id}
          current={order.assignedTo}
          title={order.assignedTo === me ? t('wf.own.handOverTitle') : t('wf.own.reassignTitle')}
          onClose={() => setHanding(false)}
        />
      ) : null}
    </>
  );
}

function HandOverDialog({
  orderId,
  current,
  title,
  onClose,
}: {
  readonly orderId: string;
  readonly current: string | null;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const agents = useQuery({
    queryKey: ['orders', 'agents'],
    queryFn: listAgents,
    staleTime: 300_000,
  });
  const options = (agents.data?.items ?? [])
    .filter(
      (agent) =>
        agent.userId !== current &&
        agent.roles.some((role) =>
          ['sales', 'org_admin', 'branch_manager', 'warehouse'].includes(role),
        ),
    )
    .map((agent) => ({ value: agent.userId, label: agent.name }));

  const save = useMutation({
    mutationFn: () => assignOrder(orderId, target),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) => setProblem(error instanceof ApiError ? error.message : t('wf.failed')),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      closeLabel={t('wf.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('wf.cancel')}
          </Button>
          <Button disabled={target === '' || save.isPending} onClick={() => save.mutate()}>
            {t('wf.own.handOver')}
          </Button>
        </>
      }
    >
      <label className="block space-y-1.5 text-sm" htmlFor={`${id}-person`}>
        <span className="font-medium">{t('wf.own.person')}</span>
        <Select
          id={`${id}-person`}
          value={target}
          placeholder={t('wf.own.choose')}
          onValueChange={setTarget}
          options={options}
        />
      </label>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
