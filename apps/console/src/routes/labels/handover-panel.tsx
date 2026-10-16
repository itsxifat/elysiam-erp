import { Button, EmptyState, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { playTone } from '../../alive/tones.js';
import { useArrivals } from '../../alive/motion.js';
import { useT } from '../../i18n/locale.js';
import { ScanField } from '../catalog/scan-field.js';
import { listQueue } from '../orders/workflow-api.js';
import { handOver, handoverPending, handoverScan, type HandoverProgress } from './api.js';

/**
 * Packaging → Handover (M46, D-808): every lot's label scanned as its bag goes to the rider;
 * an order goes to the courier (§9's `ship`, through the state machine on the server) only once
 * each of its lots is scanned. The scans are kept on the server, so a reload keeps the list.
 */
export function HandoverPanel({ locationId }: { readonly locationId: string | undefined }) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  // What this page scanned, over what the server kept from before a reload; minus what went.
  const [scanned, setScanned] = useState<ReadonlyMap<string, HandoverProgress>>(new Map());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; tone: 'neutral' | 'error' } | null>(null);
  const pending = useQuery({ queryKey: ['packing', 'handover'], queryFn: handoverPending });
  const handed = useQuery({
    queryKey: ['orders', 'hub', 'hub_handed', locationId ?? 'all'],
    queryFn: () => listQueue('hub_handed', { locationId }),
  });
  const list = new Map<string, HandoverProgress>();
  for (const item of pending.data?.items ?? []) list.set(item.orderId, item);
  for (const [orderId, item] of scanned) list.set(orderId, item);
  for (const orderId of gone) list.delete(orderId);
  const arrivals = useArrivals([...list.keys()]);

  const scan = useMutation({
    mutationFn: handoverScan,
    onSuccess: (result) => {
      setScanned((current) => new Map(current).set(result.order.orderId, result.order));
      setGone((current) => {
        const next = new Set(current);
        next.delete(result.order.orderId);
        return next;
      });
      setNotice(
        result.outcome === 'already'
          ? { text: `${result.order.orderNo}: ${t('lb.handover.already')}`, tone: 'neutral' }
          : null,
      );
      playTone(result.order.complete ? 'sent' : 'message');
    },
    onError: (error, code) => {
      playTone('error');
      setNotice({
        text: error instanceof ApiError ? `${code}: ${error.message}` : t('lb.failed'),
        tone: 'error',
      });
    },
  });

  const ready = [...list.values()].filter((entry) => entry.complete);
  const go = useMutation({
    mutationFn: () => handOver(ready.map((entry) => entry.orderId)),
    onSuccess: async (result) => {
      const refused = result.results.filter((row) => !row.ok);
      setNotice({
        text:
          `${String(result.moved)} ${t('lb.handover.orders')} ${t('lb.handover.done')}` +
          (refused.length === 0 ? '' : ` · ${String(refused.length)} ${t('lb.handover.refused')}`),
        tone: refused.length === 0 ? 'neutral' : 'error',
      });
      if (result.moved > 0) playTone('sent');
      setGone((current) => {
        const next = new Set(current);
        for (const row of result.results) if (row.ok) next.add(row.id);
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['packing', 'handover'] });
    },
  });

  return (
    <div className="space-y-4">
      <section
        aria-labelledby={`${id}-title`}
        className="space-y-3 rounded-lg border border-border bg-card p-5"
        data-testid="handover"
      >
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold">
          <Truck aria-hidden className="size-4" />
          {t('lb.handover.title')}
        </h2>
        <ScanField
          label={t('lb.handover.scan')}
          hint={t('lb.handover.hint')}
          onCode={(code) => scan.mutate(code)}
          message={notice?.text ?? null}
          tone={notice?.tone === 'error' ? 'error' : 'neutral'}
          className="max-w-xl"
        />
        {list.size === 0 ? (
          <p className="text-sm text-muted-foreground">{t('lb.handover.empty')}</p>
        ) : (
          <ul
            className="divide-y divide-border rounded-md border border-border text-sm"
            data-testid="handover-list"
          >
            {[...list.values()].map((entry) => (
              <li
                key={entry.orderId}
                className={`flex h-row items-center justify-between gap-3 px-3${arrivals.has(entry.orderId) ? 'alive-in' : ''}`}
                data-complete={entry.complete}
              >
                <span className="font-medium tabular-nums">{entry.orderNo}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {`${String(entry.scanned.length)}/${String(entry.lotCount)}`}
                  </span>
                  {entry.complete ? (
                    <StatusBadge tone="success">{t('lb.handover.allScanned')}</StatusBadge>
                  ) : (
                    <StatusBadge tone="warning">
                      {`${t('lb.handover.missing')}: ${entry.missing.map((lot) => `${t('lb.lot')} ${String(lot)}`).join(', ')}`}
                    </StatusBadge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Button
          disabled={ready.length === 0 || go.isPending}
          data-testid="hand-over"
          onClick={() => go.mutate()}
        >
          <Truck aria-hidden />
          {`${t('lb.handover.go')} ${String(ready.length)} ${t('lb.handover.orders')}`}
        </Button>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('lb.handover.today')}</h3>
        {(handed.data?.items ?? []).length === 0 ? (
          <EmptyState title={t('lb.handover.empty')} />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {(handed.data?.items ?? []).map((order) => (
              <li key={order.id} className="flex h-row items-center justify-between gap-3 px-3">
                <span className="font-medium tabular-nums">{order.orderNo}</span>
                <span className="text-xs text-muted-foreground">{order.customer.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
