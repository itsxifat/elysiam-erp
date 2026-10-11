import {
  Button,
  Dialog,
  Money,
  Select,
  Skeleton,
  StatusBadge,
  controlClassName,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  ADVANCE_METHODS,
  orderAdvances,
  recordAdvance,
  voidAdvance,
  type AdvanceMethod,
  type AdvanceRow,
  type AdvanceStatus,
} from './advances-api.js';
import type { OrderDetail } from './api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { useOwnerGuard } from './owner-guard.js';

/**
 * An order's advances, and the agent's way to record one (M17, D-013, D-230).
 *
 * The agent types what the buyer's bKash message says. Nothing is booked and the COD does not
 * move until accounts verifies it on the Advances page, which is why the panel shows each
 * claim's status in words rather than folding it into the amounts above.
 */

export const ADVANCE_TONE: Readonly<
  Record<AdvanceStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'>
> = {
  pending: 'warning',
  rejected: 'danger',
  verified: 'info',
  applied: 'success',
  refund_due: 'warning',
  refunded: 'neutral',
  forfeited: 'neutral',
  voided: 'danger',
};

const OPEN_STATUSES: readonly string[] = ['pending', 'confirmed', 'on_hold', 'packed'];

/** The courier forms' input class, so the density matches the rest of the console. */
const control = `${controlClassName} w-full disabled:opacity-50`;

export function AdvancesPanel({ order }: { readonly order: OrderDetail }) {
  const t = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const [open, setOpen] = useState(false);
  // M41 (D-710): recording an advance on somebody else's order asks first.
  const { guard } = useOwnerGuard();
  const [ack, setAck] = useState(false);
  const [undoing, setUndoing] = useState<AdvanceRow | null>(null);
  // Accounts' grant (D-235): only the people who verify can undo a verification.
  const mayUndo = ability.can('create', 'Wallet');

  const advances = useQuery({
    queryKey: ['orders', 'advances', order.id],
    queryFn: () => orderAdvances(order.id),
  });
  const canRecord = ability.can('update', 'Order') && OPEN_STATUSES.includes(order.status);
  const items = advances.data?.items ?? [];

  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t('orders.advances.heading')}</h2>
        {canRecord ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              guard((acknowledged) => {
                setAck(acknowledged);
                setOpen(true);
              })
            }
          >
            {t('orders.advances.record')}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('orders.advances.caption')}</p>
      {advances.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('orders.advances.empty')}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {items.map((advance) => (
            <li key={advance.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block font-medium tabular-nums">{advance.transactionRef}</span>
                <span className="block text-xs text-muted-foreground">
                  {t(`orders.advances.method.${advance.method}` as OrdersMessageKey)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Money poisha={advance.amountPoisha} locale={locale} />
                <StatusBadge tone={ADVANCE_TONE[advance.status]}>
                  {t(`orders.advances.status.${advance.status}` as OrdersMessageKey)}
                </StatusBadge>
                {mayUndo && advance.status === 'verified' && advance.appliedPoisha === '0' ? (
                  <Button size="sm" variant="ghost" onClick={() => setUndoing(advance)}>
                    {t('orders.advances.undo')}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open ? <RecordDialog orderId={order.id} ack={ack} onClose={() => setOpen(false)} /> : null}
      {undoing === null ? null : <UndoDialog advance={undoing} onClose={() => setUndoing(null)} />}
    </section>
  );
}

function RecordDialog({
  orderId,
  ack,
  onClose,
}: {
  readonly orderId: string;
  readonly ack: boolean;
  readonly onClose: () => void;
}) {
  const t = useOrdersT();
  const queryClient = useQueryClient();
  const id = useId();
  const [method, setMethod] = useState<AdvanceMethod>('bkash');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const amountPoisha = takaToPoisha(amount);
  const valid = reference.trim() !== '' && amountPoisha !== null && /^[1-9]\d*$/.test(amountPoisha);

  const save = useMutation({
    mutationFn: () =>
      recordAdvance(
        orderId,
        {
          method,
          transactionRef: reference.trim(),
          amountPoisha: amountPoisha ?? '0',
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        ack,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? error.message : t('orders.errorDetail')),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('orders.advances.recordTitle')}
      description={t('orders.advances.recordDetail')}
      closeLabel={t('orders.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('orders.detail.keep')}
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              if (!valid) {
                setProblem(t('orders.advances.invalid'));
                return;
              }
              setProblem(null);
              save.mutate();
            }}
          >
            {t('orders.advances.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm" htmlFor={`${id}-method`}>
          <span className="font-medium">{t('orders.advances.method')}</span>
          <Select
            id={`${id}-method`}
            value={method}
            onValueChange={(value) => setMethod(value as AdvanceMethod)}
            options={ADVANCE_METHODS.map((value) => ({
              value,
              label: t(`orders.advances.method.${value}` as OrdersMessageKey),
            }))}
          />
        </label>
        <label className="block space-y-1.5 text-sm" htmlFor={`${id}-amount`}>
          <span className="font-medium">{t('orders.advances.amount')}</span>
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            value={amount}
            className={`${control} tabular-nums`}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="block space-y-1.5 text-sm sm:col-span-2" htmlFor={`${id}-reference`}>
          <span className="font-medium">{t('orders.advances.reference')}</span>
          <input
            id={`${id}-reference`}
            value={reference}
            maxLength={40}
            autoComplete="off"
            className={`${control} uppercase tabular-nums`}
            onChange={(event) => setReference(event.target.value)}
          />
        </label>
        <label className="block space-y-1.5 text-sm sm:col-span-2" htmlFor={`${id}-note`}>
          <span className="font-medium">{t('orders.advances.note')}</span>
          <input
            id={`${id}-note`}
            value={note}
            maxLength={500}
            className={control}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      </div>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

function UndoDialog({
  advance,
  onClose,
}: {
  readonly advance: AdvanceRow;
  readonly onClose: () => void;
}) {
  const t = useOrdersT();
  const queryClient = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const undo = useMutation({
    mutationFn: () => voidAdvance(advance.id, reason.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? error.message : t('orders.errorDetail')),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`${t('orders.advances.undoTitle')} · ${advance.transactionRef}`}
      description={t('orders.advances.undoDetail')}
      closeLabel={t('orders.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('orders.detail.keep')}
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 3 || undo.isPending}
            onClick={() => {
              setProblem(null);
              undo.mutate();
            }}
          >
            {t('orders.advances.undo')}
          </Button>
        </>
      }
    >
      <label className="block space-y-1.5 text-sm" htmlFor={`${id}-reason`}>
        <span className="font-medium">{t('orders.advances.undoReason')}</span>
        <input
          id={`${id}-reason`}
          value={reason}
          maxLength={500}
          className={control}
          onChange={(event) => setReason(event.target.value)}
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
