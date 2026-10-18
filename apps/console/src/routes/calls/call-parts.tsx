import { Button, Select, StatusBadge, controlClassName } from '@elysium/ui';
import { talkTime } from '@elysium/domain/telephony';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, PhoneCall } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useOwnerGuard } from '../orders/owner-guard.js';
import { CALL_OUTCOMES, type CallOutcome } from '../orders/workflow-api.js';
import { localInputToIso } from '../orders/workflow-logic.js';
import { recordOutcome, TELEPHONY_KEY, type PhoneCallView } from './api.js';
import { useTelT, type TelT } from './messages.js';

/** The pieces every list of calls shows the same way (M47). */

export function DirectionMark({ call }: { readonly call: PhoneCallView }) {
  const t = useTelT();
  const Icon =
    call.direction === 'inbound'
      ? ArrowDownLeft
      : call.direction === 'internal'
        ? ArrowLeftRight
        : ArrowUpRight;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
      {t(`tel.direction.${call.direction}`)}
    </span>
  );
}

/** Answered, missed, failed, or where it stands while it is going. */
export function CallState({ call }: { readonly call: PhoneCallView }) {
  const t = useTelT();
  if (call.status === 'failed') {
    return <StatusBadge tone="danger">{t('tel.status.failed')}</StatusBadge>;
  }
  if (call.status !== 'ended') {
    return <StatusBadge tone="info">{t(`tel.status.${call.status}`)}</StatusBadge>;
  }
  if (call.error?.code === 'not_connected') {
    return <StatusBadge tone="neutral">{t('tel.notConnected')}</StatusBadge>;
  }
  return call.answered ? (
    <StatusBadge tone="success">{t('tel.answered')}</StatusBadge>
  ) : (
    <StatusBadge tone="warning">{t('tel.missed')}</StatusBadge>
  );
}

export function talkText(call: PhoneCallView): string {
  return call.talkSeconds === null || call.talkSeconds === 0 ? '—' : talkTime(call.talkSeconds);
}

/** The other party's number: the customer's, else whatever Envo sent. */
export function partyNumber(call: PhoneCallView): string {
  const shown = call.customerPhone ?? (call.direction === 'inbound' ? call.from : call.to);
  if (shown === null) return '—';
  return /^\+8801\d{9}$/.test(shown) ? `0${shown.slice(4)}` : shown;
}

/**
 * Record the verification outcome of a call about an order (D-838): M41's outcomes, with a
 * call-back time when one is asked for, through the order's owner guard.
 */
export function OutcomeForm({
  call,
  onDone,
}: {
  readonly call: PhoneCallView;
  readonly onDone: () => void;
}) {
  const t = useTelT();
  const id = useId();
  const queryClient = useQueryClient();
  const { guard } = useOwnerGuard();
  const [outcome, setOutcome] = useState<CallOutcome>(call.answered ? 'reached' : 'no_answer');
  const [callBackAt, setCallBackAt] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (acknowledge: boolean) => {
      const at = outcome === 'call_back' ? localInputToIso(callBackAt) : null;
      return recordOutcome(
        call.id,
        {
          outcome,
          ...(at === null ? {} : { callBackAt: at }),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        },
        acknowledge,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      onDone();
    },
    onError: (error) => setProblem(error instanceof ApiError ? error.message : t('tel.failed')),
  });
  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-border p-3"
      aria-label={t('tel.order.recordTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(null);
        guard((acknowledge) => save.mutate(acknowledge));
      }}
    >
      <label className="block space-y-1 text-sm" htmlFor={`${id}-outcome`}>
        <span className="font-medium">{t('wf.calls.outcome')}</span>
        <Select
          id={`${id}-outcome`}
          value={outcome}
          onValueChange={(value) => setOutcome(value as CallOutcome)}
          options={CALL_OUTCOMES.map((value) => ({ value, label: t(`wf.outcome.${value}`) }))}
        />
      </label>
      {outcome === 'call_back' ? (
        <label className="block space-y-1 text-sm" htmlFor={`${id}-at`}>
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
      <label className="block space-y-1 text-sm" htmlFor={`${id}-note`}>
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
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          <PhoneCall aria-hidden="true" />
          {save.isPending ? t('tel.saving') : t('tel.order.record')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('tel.cancel')}
        </Button>
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </form>
  );
}

export function outcomeLabel(t: TelT, outcome: string): string {
  return (CALL_OUTCOMES as readonly string[]).includes(outcome)
    ? t(`wf.outcome.${outcome as CallOutcome}`)
    : outcome;
}
