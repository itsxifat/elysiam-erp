import { lotCountLimit } from '@elysium/domain/packing';
import { Button, Dialog, Input, Label } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { confirmOrder } from './api.js';
import { useOrdersT } from './messages.js';

/**
 * The question at Confirm (M52, D-941): an order with more pieces than the brand's limit is asked
 * how many lots it goes in, and this sends the confirm again with the answer. The server decides
 * when to ask (`ORDER_LOTS_REQUIRED`), so the limit is never kept here. Starts at one lot, so the
 * usual answer is one key; the packer can still change it at the table.
 */
export function ConfirmLotsDialog({
  orderId,
  orderNo,
  pieces,
  ack,
  onConfirmed,
  onClose,
}: {
  readonly orderId: string;
  readonly orderNo: string;
  readonly pieces: number;
  /** M41 (D-710): the person said go ahead on somebody else's order. */
  readonly ack?: boolean;
  readonly onConfirmed: () => void;
  readonly onClose: () => void;
}) {
  const t = useOrdersT();
  const id = useId();
  const [count, setCount] = useState('1');
  const limit = lotCountLimit(pieces);
  const value = Number(count);
  const valid = Number.isInteger(value) && value >= 1 && value <= limit;
  const confirm = useMutation({
    mutationFn: () => confirmOrder(orderId, ack, value),
    onSuccess: onConfirmed,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${t('orders.lots.title')} ${orderNo}`}
      description={`${t('orders.lots.pieces')}: ${String(pieces)}. ${t('orders.lots.help')}`}
      closeLabel={t('orders.lots.notNow')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('orders.lots.notNow')}
          </Button>
          <Button
            disabled={!valid || confirm.isPending}
            data-testid="confirm-lots"
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? t('orders.lots.confirming') : t('orders.lots.confirm')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !confirm.isPending) confirm.mutate();
        }}
      >
        <Label htmlFor={`${id}-lots`}>{t('orders.lots.label')}</Label>
        <Input
          id={`${id}-lots`}
          value={count}
          inputMode="numeric"
          autoFocus
          aria-invalid={!valid}
          aria-describedby={`${id}-range`}
          className="w-24 tabular-nums"
          onChange={(event) => setCount(event.target.value)}
        />
        <p id={`${id}-range`} className="text-xs text-muted-foreground">
          {`${t('orders.lots.range')} ${String(limit)}.`}
        </p>
        {confirm.error === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {confirm.error instanceof ApiError ? confirm.error.message : t('orders.lots.failed')}
          </p>
        )}
      </form>
    </Dialog>
  );
}
