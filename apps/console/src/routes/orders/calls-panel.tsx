import { Button, DateTime, Select, StatusBadge, controlClassName } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import type { OrderDetail } from './api.js';
import { useOwnerGuard } from './owner-guard.js';
import { OrderPhoneCalls } from '../calls/order-phone-calls.js';
import { CALL_OUTCOMES, listCalls, logCall, type CallOutcome } from './workflow-api.js';
import { useNow } from './use-now.js';
import { callBackIsDue, localInputToIso } from './workflow-logic.js';

/**
 * The verification calls (M41, D-718): every attempt to reach the buyer, with what happened,
 * and a call-back time when they asked for one. The owner logs them; anybody else is asked
 * "go ahead?" first, like every desk action on somebody else's order.
 */
export function CallsPanel({
  order,
  nameOf,
}: {
  readonly order: OrderDetail;
  readonly nameOf: (userId: string | null) => string;
}) {
  const t = useT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const { guard } = useOwnerGuard();
  const [outcome, setOutcome] = useState<CallOutcome>('no_answer');
  const [callBackAt, setCallBackAt] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow(30_000);

  const calls = useQuery({
    queryKey: ['orders', 'calls', order.id],
    queryFn: () => listCalls(order.id),
  });

  const save = useMutation({
    mutationFn: (ack: boolean) => {
      const at = outcome === 'call_back' ? localInputToIso(callBackAt) : null;
      return logCall(
        order.id,
        {
          outcome,
          ...(at === null ? {} : { callBackAt: at }),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        ack,
      );
    },
    onSuccess: async () => {
      setNote('');
      setCallBackAt('');
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: async (error) => {
      setProblem(error instanceof ApiError ? error.message : t('wf.failed'));
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const callable = ['pending', 'on_hold', 'confirmed'].includes(order.status);
  const mayLog = ability.can('update', 'Order') && callable;
  const summary = order.calls;
  const items = calls.data?.items ?? [];

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-lg border border-border bg-card p-5"
      data-testid="calls-panel"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
          {t('wf.calls.title')}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {summary?.attempts ?? items.length} {t('wf.calls.attempts')}
        </span>
      </div>

      {summary?.callBackAt == null ? null : (
        <p className="text-sm">
          <StatusBadge tone={callBackIsDue(summary.callBackAt, now) ? 'warning' : 'info'}>
            {callBackIsDue(summary.callBackAt, now) ? t('wf.calls.due') : t('wf.calls.callBack')}
          </StatusBadge>{' '}
          <DateTime value={summary.callBackAt} />
        </p>
      )}

      {mayLog ? (
        <form
          className="space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (outcome === 'call_back' && localInputToIso(callBackAt) === null) {
              setProblem(t('wf.calls.needTime'));
              return;
            }
            guard((ack) => save.mutate(ack));
          }}
        >
          <label className="block space-y-1.5 text-sm" htmlFor={`${id}-outcome`}>
            <span className="font-medium">{t('wf.calls.outcome')}</span>
            <Select
              id={`${id}-outcome`}
              value={outcome}
              onValueChange={(value) => setOutcome(value as CallOutcome)}
              options={CALL_OUTCOMES.map((value) => ({
                value,
                label: t(`wf.outcome.${value}`),
              }))}
            />
          </label>
          {outcome === 'call_back' ? (
            <label className="block space-y-1.5 text-sm" htmlFor={`${id}-at`}>
              <span className="font-medium">{t('wf.calls.callBackAt')}</span>
              <input
                id={`${id}-at`}
                type="datetime-local"
                value={callBackAt}
                className={`${controlClassName} w-full tabular-nums`}
                onChange={(event) => setCallBackAt(event.target.value)}
              />
            </label>
          ) : null}
          <label className="block space-y-1.5 text-sm" htmlFor={`${id}-note`}>
            <span className="font-medium">{t('wf.calls.note')}</span>
            <input
              id={`${id}-note`}
              value={note}
              maxLength={500}
              autoComplete="off"
              className={`${controlClassName} w-full`}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={save.isPending}>
            <PhoneCall aria-hidden="true" />
            {save.isPending ? t('wf.calls.logging') : t('wf.calls.log')}
          </Button>
          {problem === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </form>
      ) : null}

      {/* M47 (D-838): Call through Envo, and each call Envo reported, with its outcome. */}
      <OrderPhoneCalls
        orderId={order.id}
        orderNo={order.orderNo}
        phone={order.shipTo.phone}
        callable={callable}
      />

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('wf.calls.none')}</p>
      ) : (
        <ol className="space-y-2 border-t border-border pt-3 text-sm" data-testid="calls-list">
          {items.map((call) => (
            <li key={call.id}>
              <span className="font-medium">{t(`wf.outcome.${call.outcome}`)}</span>
              {call.callBackAt === null ? null : (
                <span className="text-muted-foreground">
                  {' '}
                  · {t('wf.calls.callBack')} <DateTime value={call.callBackAt} />
                </span>
              )}
              {call.note === null ? null : <p className="text-muted-foreground">{call.note}</p>}
              <p className="text-xs text-muted-foreground">
                <DateTime value={call.calledAt} /> · {t('wf.calls.by')} {nameOf(call.calledBy)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
