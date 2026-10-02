import { Button, Dialog, poishaToTaka, takaToPoisha } from '@elysium/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import {
  cancelOrder,
  confirmOrder,
  deliverOrder,
  deliverPartially,
  holdOrder,
  packOrder,
  receiveReturn,
  releaseHold,
  shipOrder,
  startReturn,
  type OrderDetail,
  type OrderTrigger,
} from './api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { offeredActions } from './order-actions-logic.js';
import { RETURN_REASONS, type ReturnReason } from './returns-logic.js';

/**
 * The order's lifecycle buttons (D-392).
 *
 * **What is offered is the server's answer, not a list kept here.** The order detail carries
 * `transitions` — the rows of §9's table from the order's status, read off the same table
 * `transition()` enforces — and a button exists only for a trigger in it, and only for a
 * caller holding `update Order`. The console keeps no copy of the state machine to drift from
 * the real one: before this, Cancel was offered on a held order, which §9 does not allow, and
 * the server's refusal was the first anybody heard of it.
 *
 * Exchange is not here: it is a new order with its own lines, raised from its own form.
 */

const LABEL: Readonly<Record<OrderTrigger, OrdersMessageKey | null>> = {
  confirm: 'orders.detail.confirm',
  hold: 'orders.action.hold',
  release: 'orders.action.release',
  cancel: 'orders.detail.cancel',
  pack: 'orders.action.pack',
  ship: 'orders.action.ship',
  deliver: 'orders.action.deliver',
  deliver_partially: 'orders.action.partial',
  start_return: 'orders.action.startReturn',
  receive_return: 'orders.action.receiveReturn',
  exchange: null,
};

/** The two that move the order straight on; everything else asks something first. */
const IMMEDIATE: ReadonlySet<OrderTrigger> = new Set(['confirm', 'pack', 'release']);

const control =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const area =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

export function OrderActions({
  order,
  mayUpdate,
}: {
  readonly order: OrderDetail;
  readonly mayUpdate: boolean;
}) {
  const t = useOrdersT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<OrderTrigger | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const immediate = useMutation({
    mutationFn: async (trigger: OrderTrigger) => {
      if (trigger === 'confirm') await confirmOrder(order.id);
      else if (trigger === 'pack') await packOrder(order.id);
      else if (trigger === 'release') await releaseHold(order.id);
    },
    onSuccess: async () => {
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['courier'] });
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });

  const offered = offeredActions(order.transitions, mayUpdate);
  if (offered.length === 0) return null;

  return (
    <>
      {offered.map((trigger) => {
        const label = LABEL[trigger];
        if (label === null) return null;
        const primary = trigger === 'confirm' || trigger === 'pack' || trigger === 'ship';
        const quiet = trigger === 'cancel' || trigger === 'hold';
        return (
          <Button
            key={trigger}
            size="sm"
            variant={primary ? 'primary' : quiet ? 'ghost' : 'outline'}
            disabled={immediate.isPending}
            onClick={() => {
              if (IMMEDIATE.has(trigger)) immediate.mutate(trigger);
              else setOpen(trigger);
            }}
          >
            {t(label)}
          </Button>
        );
      })}
      {failure === null ? null : (
        <p role="alert" className="basis-full text-sm text-destructive">
          {t('orders.detail.actionFailed')} {failure}
        </p>
      )}
      {open === null ? null : (
        <ActionDialog order={order} trigger={open} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/** The dialog for a move that needs a reason, a figure or an inspection first. */
function ActionDialog({
  order,
  trigger,
  onClose,
}: {
  readonly order: OrderDetail;
  readonly trigger: OrderTrigger;
  readonly onClose: () => void;
}) {
  const t = useOrdersT();
  const queryClient = useQueryClient();
  const id = useId();
  const cod = order.amounts.codAmountPoisha;

  const [reason, setReason] = useState('');
  const [consignmentNo, setConsignmentNo] = useState('');
  // A full delivery defaults to the COD; a partial one is typed, because the full COD is
  // wrong by definition when units came back (the M15 rule for a courier's partial).
  const [collected, setCollected] = useState(
    trigger === 'deliver_partially' ? '' : poishaToTaka(cod),
  );
  const [returnReason, setReturnReason] = useState<ReturnReason | ''>('');
  const [damaged, setDamaged] = useState(false);
  const [delivered, setDelivered] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.lines.map((line) => [line.skuId, String(line.qty)])),
  );
  const [problem, setProblem] = useState<string | null>(null);

  const collectedPoisha = takaToPoisha(collected);
  const differs = collectedPoisha !== null && collectedPoisha !== cod;

  /** What the request will be, or the sentence that says why it cannot be sent yet. */
  function prepare(): (() => Promise<unknown>) | string {
    switch (trigger) {
      case 'hold':
        return reason.trim().length < 3
          ? t('orders.action.reasonNeeded')
          : () => holdOrder(order.id, reason.trim());
      case 'cancel':
        return reason.trim().length < 3
          ? t('orders.action.reasonNeeded')
          : () => cancelOrder(order.id, reason.trim());
      case 'ship':
        return () =>
          shipOrder(
            order.id,
            consignmentNo.trim() === '' ? {} : { consignmentNo: consignmentNo.trim() },
          );
      case 'deliver': {
        if (collectedPoisha === null || collectedPoisha.startsWith('-')) {
          return t('orders.action.amountNeeded');
        }
        if (differs && reason.trim().length < 3) return t('orders.action.differenceNeeded');
        return () =>
          deliverOrder(order.id, {
            collectedPoisha,
            ...(differs ? { differenceReason: reason.trim() } : {}),
          });
      }
      case 'deliver_partially': {
        if (collectedPoisha === null || collectedPoisha.startsWith('-')) {
          return t('orders.action.amountNeeded');
        }
        const lines = order.lines.map((line) => ({
          skuId: line.skuId,
          deliveredQty: Number.parseInt(delivered[line.skuId] ?? '', 10),
        }));
        const fits = lines.every(
          (line, index) =>
            Number.isInteger(line.deliveredQty) &&
            line.deliveredQty >= 0 &&
            line.deliveredQty <= (order.lines[index]?.qty ?? 0),
        );
        if (!fits) return t('orders.action.qtyNeeded');
        return () =>
          deliverPartially(order.id, {
            collectedPoisha,
            lines,
            ...(reason.trim().length >= 3 ? { differenceReason: reason.trim() } : {}),
          });
      }
      case 'start_return':
        return () => startReturn(order.id, reason.trim().length >= 3 ? reason.trim() : undefined);
      case 'receive_return':
        if (reason.trim().length < 3) return t('orders.action.reasonNeeded');
        if (returnReason === '') return t('orders.action.returnReasonNeeded');
        return () => receiveReturn(order.id, { reason: reason.trim(), returnReason, damaged });
      case 'confirm':
      case 'pack':
      case 'release':
      case 'exchange':
        // Immediate moves never open this dialog, and exchange has its own form.
        return t('orders.errorDetail');
    }
  }

  const save = useMutation({
    mutationFn: (send: () => Promise<unknown>) => send(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['courier'] });
      onClose();
    },
    onError: (error) =>
      setProblem(error instanceof ApiError ? error.message : t('orders.errorDetail')),
  });

  const copy = DIALOG_COPY[trigger];
  const field = (key: string, label: string, input: ReactNode) => (
    <label key={key} className="block space-y-1.5 text-sm" htmlFor={`${id}-${key}`}>
      <span className="font-medium">{label}</span>
      {input}
    </label>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={copy === undefined ? '' : t(copy.title)}
      {...(copy?.detail === undefined ? {} : { description: t(copy.detail) })}
      closeLabel={t('orders.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('orders.detail.keep')}
          </Button>
          <Button
            variant={trigger === 'cancel' ? 'destructive' : 'primary'}
            disabled={save.isPending}
            onClick={() => {
              const prepared = prepare();
              if (typeof prepared === 'string') {
                setProblem(prepared);
                return;
              }
              setProblem(null);
              save.mutate(prepared);
            }}
          >
            {copy === undefined ? '' : t(copy.submit)}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {trigger === 'ship'
          ? field(
              'consignment',
              t('orders.action.shipConsignment'),
              <input
                id={`${id}-consignment`}
                value={consignmentNo}
                maxLength={120}
                autoComplete="off"
                className={`${control} tabular-nums`}
                onChange={(event) => setConsignmentNo(event.target.value)}
              />,
            )
          : null}

        {trigger === 'deliver' || trigger === 'deliver_partially'
          ? field(
              'collected',
              t('orders.action.collected'),
              <input
                id={`${id}-collected`}
                inputMode="decimal"
                value={collected}
                className={`${control} tabular-nums`}
                onChange={(event) => setCollected(event.target.value)}
              />,
            )
          : null}

        {trigger === 'deliver_partially' ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('orders.action.partialLines')}</legend>
            {order.lines.map((line) => (
              <label
                key={line.skuId}
                className="flex items-center justify-between gap-3 text-sm"
                htmlFor={`${id}-qty-${line.skuId}`}
              >
                <span className="tabular-nums">
                  {line.skuCode} <span className="text-muted-foreground">/ {line.qty}</span>
                </span>
                <input
                  id={`${id}-qty-${line.skuId}`}
                  inputMode="numeric"
                  value={delivered[line.skuId] ?? ''}
                  className={`${control} w-20 text-right tabular-nums`}
                  onChange={(event) =>
                    setDelivered((current) => ({ ...current, [line.skuId]: event.target.value }))
                  }
                />
              </label>
            ))}
          </fieldset>
        ) : null}

        {trigger === 'receive_return'
          ? field(
              'code',
              t('orders.action.returnReason'),
              <select
                id={`${id}-code`}
                value={returnReason}
                className={control}
                onChange={(event) => setReturnReason(event.target.value as ReturnReason | '')}
              >
                <option value="">{t('orders.action.choose')}</option>
                {RETURN_REASONS.map((code) => (
                  <option key={code} value={code}>
                    {t(`orders.reason.${code}` as OrdersMessageKey)}
                  </option>
                ))}
              </select>,
            )
          : null}

        {trigger === 'ship' || (trigger === 'deliver' && !differs)
          ? null
          : field(
              'reason',
              t(reasonLabel(trigger)),
              <textarea
                id={`${id}-reason`}
                rows={3}
                value={reason}
                maxLength={500}
                className={area}
                onChange={(event) => setReason(event.target.value)}
              />,
            )}

        {trigger === 'receive_return' ? (
          <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-damaged`}>
            <input
              id={`${id}-damaged`}
              type="checkbox"
              checked={damaged}
              className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setDamaged(event.target.checked)}
            />
            {t('orders.action.damaged')}
          </label>
        ) : null}
      </div>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

function reasonLabel(trigger: OrderTrigger): OrdersMessageKey {
  switch (trigger) {
    case 'cancel':
      return 'orders.detail.cancelReason';
    case 'hold':
      return 'orders.action.holdReason';
    case 'deliver':
    case 'deliver_partially':
      return 'orders.action.differenceReason';
    case 'receive_return':
      return 'orders.action.inspection';
    case 'start_return':
    case 'ship':
    case 'confirm':
    case 'pack':
    case 'release':
    case 'exchange':
      return 'orders.action.note';
  }
}

const DIALOG_COPY: Partial<
  Record<
    OrderTrigger,
    { title: OrdersMessageKey; detail?: OrdersMessageKey; submit: OrdersMessageKey }
  >
> = {
  hold: { title: 'orders.action.holdTitle', submit: 'orders.action.hold' },
  cancel: { title: 'orders.detail.cancelTitle', submit: 'orders.detail.cancel' },
  ship: {
    title: 'orders.action.shipTitle',
    detail: 'orders.action.shipDetail',
    submit: 'orders.action.ship',
  },
  deliver: {
    title: 'orders.action.deliverTitle',
    detail: 'orders.action.deliverDetail',
    submit: 'orders.action.deliver',
  },
  deliver_partially: {
    title: 'orders.action.partialTitle',
    detail: 'orders.action.partialDetail',
    submit: 'orders.action.partial',
  },
  start_return: {
    title: 'orders.action.startReturnTitle',
    detail: 'orders.action.startReturnDetail',
    submit: 'orders.action.startReturn',
  },
  receive_return: {
    title: 'orders.action.receiveTitle',
    detail: 'orders.action.receiveDetail',
    submit: 'orders.action.receiveReturn',
  },
};
