import { Button, Dialog, Input, Label, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TriangleAlert, UserRoundCog } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility, useSession } from '../../auth/session.js';
import { CallButton } from '../calls/call-button.js';
import { ordersPath } from '../orders/paths.js';
import {
  buyerChecked,
  changeOrderBuyer,
  isSupervisor,
  peopleOnNumber,
  typedMobile,
} from './api.js';
import { peopleKey, usePeopleT } from './messages.js';

/** What the order page knows of the people on an order (M48, D-878, D-876). */
export interface OrderPeopleFacts {
  readonly id: string;
  readonly orderNo: string;
  readonly customer: { readonly id: string; readonly name: string; readonly phone: string };
  readonly shipTo: { readonly name: string; readonly phone: string };
  readonly placedFor?: string;
  readonly placedForNote?: string | null;
  readonly recipientCustomerId?: string | null;
  readonly buyerCheck?: string | null;
}

const linkClass =
  'mt-1 inline-block text-sm font-medium underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * The order page's buyer and recipient (D-878): who ordered and whom the brand deals with, apart
 * from whom the parcel goes to, each with their own Call (M47's button and owner gate). The desk's
 * "check the buyer" (D-876) with "Buyer is right", and a supervisor's Change buyer (D-882).
 */
export function OrderPeople({ order }: { readonly order: OrderPeopleFacts }) {
  const t = usePeopleT();
  const ability = useAbility();
  const session = useSession();
  const queryClient = useQueryClient();
  const supervisor = isSupervisor(
    session.context?.roles ?? [],
    session.context?.isSuperAdmin ?? false,
  );
  const mayUpdate = ability.can('update', 'Order');
  const [changing, setChanging] = useState(false);
  const forSomeoneElse = order.placedFor === 'someone_else';
  const checked = useMutation({
    mutationFn: () => buyerChecked(order.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  return (
    <div className="space-y-3">
      {order.buyerCheck === 'shared_number' ? (
        <div
          role="status"
          className="flex flex-wrap items-start gap-3 rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-subtle-foreground"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('people.order.check')}</p>
            <p>{t('people.order.checkDetail')}</p>
          </div>
          {mayUpdate ? (
            <Button
              size="sm"
              variant="outline"
              disabled={checked.isPending}
              onClick={() => checked.mutate()}
            >
              {t('people.order.buyerRight')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div>
        <h2 className="text-xs font-medium text-muted-foreground">{t('people.order.buyer')}</h2>
        <Link to={ordersPath(`/customers/${order.customer.id}`)} className={linkClass}>
          {order.customer.name}
        </Link>
        <p className="flex flex-wrap items-center gap-2 text-sm tabular-nums">
          {order.customer.phone}
          {/* M47 (D-834): ring your own extension, then the buyer. */}
          <CallButton
            target={{ orderId: order.id, phone: order.customer.phone }}
            phone={order.customer.phone}
            label={`${t('people.order.callBuyer')} · ${order.orderNo}`}
            size="icon"
          />
          {mayUpdate && supervisor ? (
            <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
              <UserRoundCog aria-hidden="true" />
              {t('people.order.changeBuyer')}
            </Button>
          ) : null}
        </p>
      </div>
      {forSomeoneElse || order.shipTo.phone !== order.customer.phone ? (
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            {t('people.order.recipient')}
            {forSomeoneElse ? (
              <StatusBadge tone="info">{t('people.order.forSomeoneElse')}</StatusBadge>
            ) : null}
          </h2>
          <p className="mt-1 text-sm font-medium">{order.shipTo.name}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm tabular-nums">
            {order.shipTo.phone}
            <CallButton
              target={{ orderId: order.id, phone: order.shipTo.phone }}
              phone={order.shipTo.phone}
              label={`${t('people.order.callRecipient')} · ${order.orderNo}`}
              size="icon"
            />
          </p>
          {order.placedForNote ? (
            <p className="text-sm text-muted-foreground">{order.placedForNote}</p>
          ) : null}
          {order.recipientCustomerId ? (
            <Link to={ordersPath(`/customers/${order.recipientCustomerId}`)} className={linkClass}>
              {t('people.order.recipientRecord')}
            </Link>
          ) : null}
        </div>
      ) : null}
      {changing ? <ChangeBuyer order={order} onClose={() => setChanging(false)} /> : null}
    </div>
  );
}

function ChangeBuyer({
  order,
  onClose,
}: {
  readonly order: OrderPeopleFacts;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(order.customer.phone);
  const [chosen, setChosen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const mobile = typedMobile(phone);
  const found = useQuery({
    queryKey: ['people', 'on-number', mobile],
    queryFn: () => peopleOnNumber(mobile ?? ''),
    enabled: mobile !== null,
  });
  const people = found.data?.candidates ?? [];
  const save = useMutation({
    mutationFn: () => changeOrderBuyer(order.id, chosen ?? '', reason.trim()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
  });
  const ready = chosen !== null && reason.trim().length >= 3;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.order.changeTitle')}
      description={t('people.order.changeDetail')}
      closeLabel={t('people.numbers.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('people.numbers.cancel')}
          </Button>
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('people.numbers.saving') : t('people.order.changeConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-phone`}>{t('people.order.changeFind')}</Label>
          <Input
            id={`${id}-phone`}
            type="tel"
            inputMode="tel"
            value={phone}
            className="tabular-nums"
            onChange={(event) => {
              setPhone(event.target.value);
              setChosen(null);
            }}
          />
        </div>
        {mobile === null ? null : people.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {found.isPending ? t('people.numbers.saving') : t('people.merge.noneFound')}
          </p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('people.merge.pick')}</legend>
            {people.map((person) => {
              const relation = peopleKey('relation', person.relation);
              return (
                <label
                  key={person.customerId}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm"
                >
                  <input
                    type="radio"
                    name={`${id}-buyer`}
                    checked={chosen === person.customerId}
                    onChange={() => setChosen(person.customerId)}
                    className="mt-1 focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span>
                    <span className="block font-medium">{person.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {relation === null ? person.relation : t(relation)}
                      {person.note === null ? '' : ` · ${person.note}`}
                      {' · '}
                      {t('people.chooser.orders', { count: person.orders })}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reason`} required>
            {t('people.order.changeReason')}
          </Label>
          <Input
            id={`${id}-reason`}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
