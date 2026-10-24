import { Button, cn, PageHeader, PermissionGate, StatusBadge } from '@elysium/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, CircleAlert, Maximize2, Minimize2, PackageCheck, Truck } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { playTone } from '../../alive/tones.js';
import { useT } from '../../i18n/locale.js';
import { ScanField } from '../catalog/scan-field.js';
import { handOver, handoverScan } from './api.js';
import { ThisComputer } from './parts.js';
import {
  PORTAL_EMPTY,
  portalReducer,
  shippedTotal,
  type PortalEntry,
  type PortalOutcome,
} from './portal-logic.js';

/**
 * The courier portal (D-904): one page, one scan field, for the person handing parcels to the
 * rider. Each scan of a slip, a label or a lot code is recorded as Packaging → Handover records
 * it (`POST /v1/packing/handover/scans`, D-808), and the moment an order's last lot is scanned
 * the order is handed to the courier and shipped (`POST /v1/packing/handover`, the state
 * machine's `ship`), with no button to press. Scans are worked one after another, in the order
 * they arrive, so two lots of one order read fast never race. The page counts each courier's
 * parcels this session and fills the window on request.
 */

const OUTCOME_TONE: Record<PortalOutcome, 'success' | 'warning' | 'neutral' | 'danger'> = {
  shipped: 'success',
  partial: 'warning',
  already: 'neutral',
  refused: 'danger',
};

export function CourierPortalPage() {
  const t = useT();
  const ability = useAbility();
  // The hub's people and supervisors, as Packaging; and the handover is `update Order` (D-820).
  return (
    <PermissionGate
      allowed={ability.can('read', 'PackingTerminal') && ability.can('update', 'Order')}
      explain={{ title: t('lb.portal.title'), detail: t('lb.labels.denied') }}
    >
      <CourierPortal />
    </PermissionGate>
  );
}

/** Whether this browser can fill the window (it cannot on an iPhone, D-904's review). */
const canFill = () => typeof document !== 'undefined' && document.fullscreenEnabled;

function CourierPortal() {
  const t = useT();
  const queryClient = useQueryClient();
  const [state, record] = useReducer(portalReducer, PORTAL_EMPTY);
  // Scans not answered yet: "Working…" until the last of them is (D-904's review).
  const [waiting, setWaiting] = useState(0);
  const [full, setFull] = useState(false);
  // The scans waiting their turn: worked strictly in order, one at a time.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const keys = useRef(0);

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const work = async (code: string): Promise<void> => {
    keys.current += 1;
    const key = keys.current;
    const base = { key, code, missing: [], lotCount: 1, message: null };
    try {
      const scanned = await handoverScan(code);
      const order = scanned.order;
      const known = { orderNo: order.orderNo, courier: order.courier, lotCount: order.lotCount };
      if (!order.complete) {
        record({ ...base, ...known, outcome: 'partial', missing: order.missing });
        playTone('message');
        return;
      }
      const result = await handOver([order.orderId]);
      const row = result.results[0];
      if (row?.ok === true) {
        record({ ...base, ...known, outcome: 'shipped' });
        playTone('sent');
      } else if (row?.code === 'ORDER_ALREADY_HANDED') {
        // Shipped meanwhile: the courier's pickup, or another desk.
        record({ ...base, ...known, outcome: 'already', message: row.message ?? null });
        playTone('message');
      } else {
        record({
          ...base,
          ...known,
          outcome: 'refused',
          message: row?.message ?? t('lb.failed'),
        });
        playTone('error');
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('lb.failed');
      // An order already with the courier is not a mistake to sound an alarm for.
      const already = error instanceof ApiError && error.code === 'ORDER_ALREADY_HANDED';
      record({
        ...base,
        orderNo: null,
        courier: null,
        outcome: already ? 'already' : 'refused',
        message,
      });
      playTone(already ? 'message' : 'error');
    } finally {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['packing', 'handover'] });
    }
  };

  const onCode = (code: string) => {
    setWaiting((count) => count + 1);
    chain.current = chain.current
      .then(() => work(code))
      .finally(() => setWaiting((count) => count - 1));
  };

  const toggleFull = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    } else {
      void document.exitFullscreen().catch(() => undefined);
    }
  };

  const last = state.entries[0];
  const total = shippedTotal(state);
  return (
    <div className="space-y-5" data-testid="courier-portal">
      <PageHeader
        title={t('lb.portal.title')}
        description={t('lb.portal.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <ThisComputer />
            {canFill() ? (
              <Button variant="outline" onClick={toggleFull}>
                {full ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
                {full ? t('lb.portal.exitFull') : t('lb.portal.full')}
              </Button>
            ) : null}
          </div>
        }
      />

      <section className="space-y-4 rounded-lg border border-border bg-card p-5">
        <ScanField
          label={t('lb.portal.scan')}
          hint={t('lb.portal.hint')}
          onCode={onCode}
          message={waiting > 0 ? t('lb.portal.working') : null}
        />
        {/* Always in the page, so the first scan's answer is read out too (D-904's review). */}
        <div role="status" aria-live="polite" data-testid="portal-last">
          {last === undefined ? null : <LastScan entry={last} />}
        </div>
      </section>

      <section className="space-y-3" aria-label={t('lb.portal.counts')}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-semibold">{t('lb.portal.counts')}</h2>
          <StatusBadge tone={total > 0 ? 'success' : 'neutral'}>
            {`${String(total)} ${t('lb.portal.shipped')}`}
          </StatusBadge>
          {[...state.shipped.entries()].map(([courier, count]) => (
            <span
              key={courier}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm"
            >
              <Truck aria-hidden className="size-4 text-muted-foreground" />
              {courier === '' ? t('lb.portal.noCourier') : courier}
              <span className="font-semibold tabular-nums">{count}</span>
            </span>
          ))}
        </div>
        {state.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('lb.portal.empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
            {state.entries.map((entry) => (
              <li key={entry.key} className="flex h-row items-center justify-between gap-3 px-3">
                <span className="min-w-0 truncate tabular-nums">
                  {entry.orderNo ?? entry.code}
                  {entry.courier === null ? '' : ` · ${entry.courier}`}
                </span>
                <StatusBadge tone={OUTCOME_TONE[entry.outcome]}>
                  {t(`lb.portal.outcome.${entry.outcome}`)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {t('lb.portal.batch')}{' '}
          <Link
            to="/packaging"
            search={{ tab: 'handover' }}
            className="underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t('lb.ptab.handover')}
          </Link>
        </p>
      </section>
    </div>
  );
}

/** The answer to the last scan, large enough to read from the rider's side of the desk. */
function LastScan({ entry }: { readonly entry: PortalEntry }) {
  const t = useT();
  const shipped = entry.outcome === 'shipped';
  const bad = entry.outcome === 'refused';
  const Icon = shipped ? CheckCircle2 : bad ? CircleAlert : PackageCheck;
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4',
        shipped && 'border-success bg-success-subtle text-success-subtle-foreground',
        bad && 'border-destructive bg-destructive-subtle text-destructive-subtle-foreground',
        !shipped && !bad && 'border-warning bg-warning-subtle text-warning-subtle-foreground',
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-6 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-lg font-semibold tabular-nums">
          {`${t(`lb.portal.outcome.${entry.outcome}`)} · ${entry.orderNo ?? entry.code}`}
        </p>
        {entry.courier === null ? null : <p className="text-sm">{entry.courier}</p>}
        {entry.outcome === 'partial' ? (
          <p className="text-sm">
            {`${t('lb.portal.stillToScan')}: ${entry.missing.map((lot) => `${t('lb.lot')} ${String(lot)}`).join(', ')} (${String(entry.lotCount)} ${t('lb.portal.lots')})`}
          </p>
        ) : null}
        {entry.message === null ? null : <p className="text-sm">{entry.message}</p>}
      </div>
    </div>
  );
}
