import { Button, EmptyState, Input, Label, Money, StatusBadge, takaToPoisha } from '@elysium/ui';
import { Printer, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { useLocale, usePosT } from '../i18n/locale.js';
import type { PosMessageKey } from '../i18n/messages.js';
import { endpoints, NetworkError, type ShiftView } from '../lib/api.js';
import { requeue, type OutboxEntry } from '../lib/store.js';
import type { ReceiptData } from '../receipt/receipt.js';

/**
 * The queue and the shift close — the two screens that are about the server
 * having the till's sales.
 */

const STATUS_KEY: Record<OutboxEntry['status'], PosMessageKey> = {
  queued: 'pos.queue.statusQueued',
  synced: 'pos.queue.statusSynced',
  failed: 'pos.queue.statusFailed',
};

const OUTCOME_KEY: Record<string, PosMessageKey> = {
  posted: 'pos.queue.outcomePosted',
  held: 'pos.queue.outcomeHeld',
  voided: 'pos.queue.outcomeVoided',
};

export function Queue({
  entries,
  onRetry,
  onReprint,
}: {
  readonly entries: readonly OutboxEntry[];
  readonly onRetry: () => void;
  readonly onReprint: (receipt: ReceiptData) => void;
}) {
  const t = usePosT();
  const { locale } = useLocale();
  const newestFirst = [...entries].reverse();

  return (
    <main id="main" className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{t('pos.queue.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('pos.queue.detail')}</p>
      </header>
      {newestFirst.length === 0 ? (
        <EmptyState className="bg-card" title={t('pos.queue.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm" data-testid="queue">
            <tbody>
              {newestFirst.map((entry) => {
                const receipt = entry.receipt as ReceiptData;
                return (
                  <tr key={entry.id} className="border-t border-border" data-status={entry.status}>
                    <td className="h-row px-3 font-mono">{receipt.receiptNo}</td>
                    <td className="h-row px-3 text-muted-foreground">
                      {t(entry.kind === 'sale' ? 'pos.queue.kindSale' : 'pos.queue.kindReturn')}
                    </td>
                    <td className="h-row px-3">
                      <Money poisha={receipt.netPoisha} locale={locale} />
                    </td>
                    <td className="h-row px-3">
                      <StatusBadge
                        tone={
                          entry.status === 'failed'
                            ? 'danger'
                            : entry.status === 'queued'
                              ? 'warning'
                              : entry.outcome === 'held'
                                ? 'info'
                                : 'success'
                        }
                      >
                        {entry.status === 'synced' &&
                        entry.outcome !== null &&
                        OUTCOME_KEY[entry.outcome] !== undefined
                          ? t(OUTCOME_KEY[entry.outcome] ?? 'pos.queue.statusSynced')
                          : t(STATUS_KEY[entry.status])}
                      </StatusBadge>
                      {entry.error === null ? null : (
                        <span className="ml-2 text-xs text-destructive">{entry.error}</span>
                      )}
                    </td>
                    <td className="h-row px-3 text-right">
                      {entry.status === 'failed' ? (
                        <Button
                          size="lg"
                          className="min-h-11"
                          variant="outline"
                          onClick={() => {
                            void requeue(entry.id).then(onRetry);
                          }}
                        >
                          <RefreshCw aria-hidden />
                          {t('pos.queue.retry')}
                        </Button>
                      ) : null}
                      <Button
                        size="lg"
                        className="min-h-11"
                        variant="ghost"
                        onClick={() => {
                          onReprint(receipt);
                        }}
                      >
                        <Printer aria-hidden />
                        {t('pos.queue.reprint')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

export function CloseShift({
  shiftId,
  online,
  waiting,
  failed,
  onClosed,
}: {
  readonly shiftId: string;
  readonly online: boolean;
  readonly waiting: number;
  readonly failed: number;
  readonly onClosed: () => void;
}) {
  const t = usePosT();
  const { locale } = useLocale();
  const [shift, setShift] = useState<ShiftView | null>(null);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked =
    waiting > 0
      ? t('pos.shift.closeBlockedQueue')
      : failed > 0
        ? t('pos.shift.closeBlockedFailed')
        : null;

  useEffect(() => {
    if (!online || blocked !== null) return;
    endpoints
      .shift(shiftId)
      .then(setShift)
      .catch(() => {
        setError(t('pos.error.generic'));
      });
  }, [shiftId, online, blocked, t]);

  const countedPoisha = takaToPoisha(counted);
  const expected = shift?.drawer?.expectedCashPoisha ?? null;
  const variance =
    countedPoisha === null || expected === null ? null : BigInt(countedPoisha) - BigInt(expected);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (countedPoisha === null || countedPoisha.startsWith('-')) {
      setError(t('pos.shift.floatInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.closeShift(shiftId, {
        countedCashPoisha: countedPoisha,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      onClosed();
    } catch (caught) {
      setError(
        caught instanceof NetworkError ? t('pos.shift.needsOnline') : t('pos.error.generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto w-full max-w-md space-y-6 p-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{t('pos.shift.closeTitle')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('pos.shift.closeDetail')}</p>
      </header>
      {blocked === null ? null : (
        <p
          role="alert"
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground"
        >
          {blocked}
        </p>
      )}
      {!online ? (
        <p
          role="alert"
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground"
        >
          {t('pos.shift.needsOnline')}
        </p>
      ) : null}
      <form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('pos.shift.expected')}</dt>
          <dd>{expected === null ? <Pending /> : <Money poisha={expected} locale={locale} />}</dd>
          <dt className="text-muted-foreground">{t('pos.shift.variance')}</dt>
          <dd>{variance === null ? <Pending /> : <Money poisha={variance} locale={locale} />}</dd>
        </dl>
        <div className="space-y-1.5">
          <Label htmlFor="counted">{t('pos.shift.counted')}</Label>
          <Input
            id="counted"
            inputMode="decimal"
            autoFocus
            value={counted}
            onChange={(event) => {
              setCounted(event.target.value);
            }}
            className="min-h-11 text-right tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="close-note">{t('pos.shift.note')}</Label>
          <Input
            id="close-note"
            maxLength={500}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            className="min-h-11"
          />
        </div>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          type="submit"
          size="lg"
          className="min-h-11 w-full"
          disabled={busy || !online || blocked !== null}
        >
          {t('pos.shift.close')}
        </Button>
      </form>
    </main>
  );
}

/** A figure not known yet — not zero, and not withheld. */
function Pending() {
  return (
    <span className="block text-right text-muted-foreground" aria-hidden>
      &mdash;
    </span>
  );
}
