import { Button, cn, DateTime, StatusBadge, controlClassName } from '@elysium/ui';
import { talkTime } from '@elysium/domain/telephony';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, ClipboardCheck } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useOwnerGuard } from '../orders/owner-guard.js';
import { CALL_OUTCOMES, type CallOutcome } from '../orders/workflow-api.js';
import { localInputToIso } from '../orders/workflow-logic.js';
import { TELEPHONY_KEY, wrapUpCall, type CallWrapUp, type PhoneCallView } from './api.js';
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

/** M41's owner gate refused: the order is a colleague's (D-710). */
const HANDLED_BY_OTHER = 'ORDER_HANDLED_BY_OTHER';

/** The results whose wrap-up needs a note: what was agreed, or what to call back about. */
const NEEDS_NOTE: readonly CallOutcome[] = ['reached', 'call_back'];

/**
 * The person's wrap-up after their call (D-859): M41's five results with the ERP's suggestion
 * picked and marked (the person may choose another; nothing is picked when the ERP cannot tell),
 * what it was about or what was agreed, and a call-back time. Never saved by itself. On a call
 * about a colleague's order the order page's owner guard asks first; anywhere else the server's
 * refusal is shown with Go ahead, and the wrap-up is sent again with the acknowledgement.
 */
export function WrapUpForm({
  call,
  onDone,
  dismissLabel,
  onDismiss,
  orderCallable,
}: {
  readonly call: PhoneCallView;
  /** Told whether M41's attempt was also logged on the call's order. */
  readonly onDone: (orderAttempt: boolean) => void;
  readonly dismissLabel: string;
  readonly onDismiss: () => void;
  /** False when the call's order can no longer be called about: only the wrap-up is kept. */
  readonly orderCallable?: boolean;
}) {
  const t = useTelT();
  const id = useId();
  const queryClient = useQueryClient();
  const { guard } = useOwnerGuard();
  const [result, setResult] = useState<CallOutcome | null>(call.suggestedResult);
  const [note, setNote] = useState('');
  const [callBackAt, setCallBackAt] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [handledBy, setHandledBy] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: { readonly result: CallOutcome; readonly acknowledge: boolean }) => {
      const at = input.result === 'call_back' ? localInputToIso(callBackAt) : null;
      return wrapUpCall(
        call.id,
        {
          result: input.result,
          ...(note.trim() === '' ? {} : { note: note.trim() }),
          ...(at === null ? {} : { callBackAt: at }),
        },
        input.acknowledge,
      );
    },
    onSuccess: async (answer) => {
      setHandledBy(null);
      await queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY });
      if (call.order !== null) await queryClient.invalidateQueries({ queryKey: ['orders'] });
      onDone(answer.orderAttempt);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === HANDLED_BY_OTHER) {
        setHandledBy(error.message);
        return;
      }
      setProblem(error instanceof ApiError ? error.message : t('tel.failed'));
    },
  });
  const send = (acknowledge: boolean) => {
    if (result !== null) save.mutate({ result, acknowledge });
  };

  return (
    <form
      className="space-y-3 rounded-md border border-border bg-card p-3"
      aria-label={t('tel.wrap.title')}
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(null);
        setHandledBy(null);
        if (result === null) {
          setProblem(t('tel.wrap.pick'));
          return;
        }
        if (NEEDS_NOTE.includes(result) && note.trim().length < 2) {
          setProblem(
            result === 'call_back' ? t('tel.wrap.callBackNote') : t('tel.wrap.noteNeeded'),
          );
          return;
        }
        if (result === 'call_back' && localInputToIso(callBackAt) === null) {
          setProblem(t('wf.calls.needTime'));
          return;
        }
        guard((acknowledge) => send(acknowledge));
      }}
    >
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{t('tel.wrap.result')}</legend>
        <div className="flex flex-wrap gap-1.5">
          {CALL_OUTCOMES.map((value) => (
            <label
              key={value}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                result === value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <input
                type="radio"
                className="sr-only"
                name={`${id}-result`}
                value={value}
                checked={result === value}
                onChange={() => setResult(value)}
              />
              {t(`wf.outcome.${value}`)}
              {value === call.suggestedResult ? (
                <span className="rounded-sm bg-muted px-1 text-xs text-muted-foreground">
                  {t('tel.wrap.suggested')}
                </span>
              ) : null}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-1 text-sm" htmlFor={`${id}-note`}>
        <span className="font-medium">{t('tel.wrap.note')}</span>
        <textarea
          id={`${id}-note`}
          value={note}
          rows={3}
          maxLength={1000}
          className={`${controlClassName} h-auto min-h-16 w-full py-2`}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {result === 'call_back' ? (
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
      {call.order !== null && orderCallable === false ? (
        <p className="text-xs text-muted-foreground">{t('tel.wrap.orderClosed')}</p>
      ) : null}
      {handledBy === null ? null : (
        <div
          role="alert"
          className="space-y-2 rounded-md border border-border bg-muted/50 p-2 text-sm"
        >
          <p>{handledBy}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={save.isPending} onClick={() => send(true)}>
              {t('wf.own.ackGo')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setHandledBy(null)}>
              {t('wf.own.ackStop')}
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          <Check aria-hidden="true" />
          {save.isPending ? t('tel.saving') : t('tel.wrap.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          {dismissLabel}
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

/** A call's wrap-up as written: the result, what it was about, and the call-back time. */
export function WrapUpSummary({ wrapUp }: { readonly wrapUp: CallWrapUp }) {
  const t = useTelT();
  return (
    <div className="space-y-0.5 text-sm">
      <StatusBadge tone="neutral">{t(`wf.outcome.${wrapUp.result}`)}</StatusBadge>
      {wrapUp.note === null ? null : (
        <p className="max-w-xs break-words whitespace-pre-line text-muted-foreground">
          {wrapUp.note}
        </p>
      )}
      {wrapUp.callBackAt === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('wf.calls.callBack')}: <DateTime value={wrapUp.callBackAt} />
        </p>
      )}
    </div>
  );
}

/**
 * A call's wrap-up where calls are listed (D-859): what was written, else Wrap up for the
 * viewer's own ended call, which opens the form in place.
 */
export function WrapUpCell({
  call,
  orderCallable,
  dash = false,
}: {
  readonly call: PhoneCallView;
  readonly orderCallable?: boolean;
  /** Show a dash when there is nothing to show (a table cell). */
  readonly dash?: boolean;
}) {
  const t = useTelT();
  const [open, setOpen] = useState(false);
  if (call.wrapUp !== null) return <WrapUpSummary wrapUp={call.wrapUp} />;
  if (!call.canWrapUp) return dash ? <span className="text-muted-foreground">—</span> : null;
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ClipboardCheck aria-hidden="true" />
        {t('tel.wrap.button')}
      </Button>
    );
  }
  return (
    <div className="min-w-72">
      <WrapUpForm
        call={call}
        {...(orderCallable === undefined ? {} : { orderCallable })}
        dismissLabel={t('tel.cancel')}
        onDismiss={() => setOpen(false)}
        onDone={() => setOpen(false)}
      />
    </div>
  );
}

export function outcomeLabel(t: TelT, outcome: string): string {
  return (CALL_OUTCOMES as readonly string[]).includes(outcome)
    ? t(`wf.outcome.${outcome as CallOutcome}`)
    : outcome;
}
