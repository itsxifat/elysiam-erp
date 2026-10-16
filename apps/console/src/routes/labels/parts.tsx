import type { MessageKey } from '@elysium/i18n';
import { Button, Dialog, Input, Label, Select, StatusBadge, cn } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { useCallback, useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { playTone } from '../../alive/tones.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/labels.js';
import { useRealtime, type RealtimeStatus } from '../../realtime/use-realtime.js';
import { listLocations } from '../courier/api.js';
import { myDesk } from '../orders/workflow-api.js';
import {
  printNow,
  setLotCount,
  type JobState,
  type PresenceState,
  type PrintRequest,
  type PrinterState,
} from './api.js';
import { useTerminalCheckIn } from './terminal-binding.js';

/** Labels' and Packaging's shared pieces (M46): badges, the reprint reason, the location. */

export const JOB_TONE: Readonly<Record<JobState, 'neutral' | 'info' | 'success' | 'danger'>> = {
  queued: 'neutral',
  sending: 'info',
  printed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export function JobStateBadge({ state }: { readonly state: JobState }) {
  const t = useT();
  return <StatusBadge tone={JOB_TONE[state]}>{t(`lb.state.${state}` as MessageKey)}</StatusBadge>;
}

const PRINTER_TONE: Readonly<Record<PrinterState, 'neutral' | 'success' | 'danger' | 'warning'>> = {
  online: 'success',
  offline: 'danger',
  error: 'danger',
  unknown: 'warning',
  off: 'neutral',
};

export function PrinterStateBadge({
  state,
  detail,
}: {
  readonly state: PrinterState;
  readonly detail?: string | null;
}) {
  const t = useT();
  return (
    <StatusBadge tone={PRINTER_TONE[state]}>
      {t(`lb.printer.state.${state}` as MessageKey)}
      {detail === null || detail === undefined || detail === '' ? '' : ` · ${detail}`}
    </StatusBadge>
  );
}

const PRESENCE_TONE: Readonly<Record<PresenceState, 'success' | 'warning' | 'neutral'>> = {
  active: 'success',
  idle: 'warning',
  away: 'neutral',
};

export function PresenceBadge({ state }: { readonly state: PresenceState }) {
  const t = useT();
  return (
    <StatusBadge tone={PRESENCE_TONE[state]}>{t(`lb.presence.${state}` as MessageKey)}</StatusBadge>
  );
}

/** "Lot 2 of 3", or nothing for an order in one lot. */
export function lotText(t: (key: MessageKey) => string, lot: number, count: number): string {
  return count <= 1 ? '' : `${t('lb.lot')} ${String(lot)} ${t('lb.of')} ${String(count)}`;
}

/**
 * The print queue's live layer: a job's change invalidates what shows it, and a printed or a
 * failed job is heard (M44a's tones: `sent` and `error`, the person's own mute and volume).
 */
export function useLabelEvents(options: { readonly sounds?: boolean } = {}): RealtimeStatus {
  const queryClient = useQueryClient();
  const sounds = options.sounds ?? true;
  const onEvent = useCallback(
    (_name: string, payload: unknown) => {
      void queryClient.invalidateQueries({ queryKey: ['labels'] });
      void queryClient.invalidateQueries({ queryKey: ['terminals'] });
      const state = (payload as { state?: unknown } | null)?.state;
      if (!sounds) return;
      if (state === 'printed') playTone('sent');
      if (state === 'failed') playTone('error');
    },
    [queryClient, sounds],
  );
  return useRealtime({ events: ['labels.job_changed'], onEvent });
}

/**
 * Print, asking for a reason when the server says it is a reprint (D-818): the request goes as
 * it is; a `PRINT_REASON_REQUIRED` opens the reason dialog, and the same request goes again
 * with the reason.
 */
export function usePrint(onDone: (queued: number) => void) {
  const t = useT();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PrintRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (input: PrintRequest) => {
    setBusy(true);
    setError(null);
    try {
      const result = await printNow(input);
      setPending(null);
      onDone(result.jobs.length);
      await queryClient.invalidateQueries({ queryKey: ['labels'] });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PRINT_REASON_REQUIRED') {
        setPending(input);
      } else {
        setError(caught instanceof ApiError ? caught.message : t('lb.failed'));
        playTone('error');
      }
    } finally {
      setBusy(false);
    }
  };
  const dialog =
    pending === null ? null : (
      <ReasonDialog
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => void send({ ...pending, reason })}
      />
    );
  return { print: (input: PrintRequest) => void send(input), busy, error, dialog };
}

export function ReasonDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('lb.reprint.title')}
      description={t('lb.reprint.detail')}
      closeLabel={t('lb.close')}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            {t('lb.cancel')}
          </Button>
          <Button disabled={!valid || busy} onClick={() => onConfirm(reason.trim())}>
            {t('lb.reprint.confirm')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onConfirm(reason.trim());
        }}
      >
        <Label htmlFor={`${id}-reason`}>{t('lb.reprint.reason')}</Label>
        <Input
          id={`${id}-reason`}
          value={reason}
          maxLength={200}
          autoFocus
          onChange={(event) => setReason(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

/** The hub's stock locations, with the person's own hub first (M41's desk profile). */
export function useHubLocations() {
  const t = useT();
  const desk = useQuery({ queryKey: ['team', 'me'], queryFn: myDesk });
  const locations = useQuery({ queryKey: ['inventory', 'locations'], queryFn: listLocations });
  const hub = desk.data?.profile.hubLocationId ?? null;
  const usable = (locations.data?.items ?? []).filter(
    (place) => place.isActive && ['warehouse', 'showroom'].includes(place.kind),
  );
  return {
    hub,
    names: new Map(usable.map((place) => [place.id, place.name])),
    options: [
      { value: '', label: t('lb.allLocations') },
      ...usable.map((place) => ({ value: place.id, label: place.name })),
    ],
  };
}

export function LocationSelect({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  const id = useId();
  const { options } = useHubLocations();
  return (
    <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-location`}>
      <span className="text-muted-foreground">{t('lb.location')}</span>
      <Select
        id={`${id}-location`}
        size="sm"
        value={value}
        onValueChange={onChange}
        options={options}
        placeholder={t('lb.allLocations')}
      />
    </label>
  );
}

/** "This computer: Label 1", or that it is not bound; checked in every half minute. */
export function ThisComputer() {
  const t = useT();
  const { binding, checkIn } = useTerminalCheckIn();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs',
        binding === null ? 'text-muted-foreground' : 'text-foreground',
      )}
      data-testid="this-computer"
    >
      <Monitor aria-hidden className="size-3.5" />
      {binding === null ? t('lb.notBound') : `${t('lb.thisComputer')}: ${binding.terminalName}`}
      {checkIn !== undefined && !checkIn.assigned && !checkIn.supervisor ? (
        <span className="text-destructive-text">{` · ${t('lb.notAssigned')}`}</span>
      ) : null}
    </span>
  );
}

/** How many bags an order goes in (D-805), before its labels print. */
export function LotsDialog({
  order,
  onClose,
}: {
  readonly order: { readonly orderId: string; readonly orderNo: string; readonly lotCount: number };
  readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [count, setCount] = useState(String(order.lotCount));
  const value = Number(count);
  const valid = Number.isInteger(value) && value >= 1 && value <= 20;
  const save = useMutation({
    mutationFn: () => setLotCount(order.orderId, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['labels'] });
      await queryClient.invalidateQueries({ queryKey: ['packing'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${t('lb.lots.for')} ${order.orderNo}`}
      description={t('lb.lots.hint')}
      closeLabel={t('lb.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('lb.cancel')}
          </Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('lb.saving') : t('lb.save')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <Label htmlFor={`${id}-lots`}>{t('lb.lots.title')}</Label>
        <Input
          id={`${id}-lots`}
          value={count}
          inputMode="numeric"
          autoFocus
          onChange={(event) => setCount(event.target.value)}
        />
        {save.error === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {save.error instanceof ApiError ? save.error.message : t('lb.failed')}
          </p>
        )}
      </form>
    </Dialog>
  );
}
