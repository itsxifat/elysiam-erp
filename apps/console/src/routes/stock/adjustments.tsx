import { Button, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  listAdjustments,
  listLocations,
  listReconciliations,
  listStock,
  requestAdjustment,
  type AdjustmentRow,
} from './api.js';
import { StockNav } from './stock-nav.js';
import { useStockT, type StockMessageKey } from './messages.js';

/**
 * Write-offs, gains and the nightly check (M07 Build list; check 4's screen).
 *
 * The form's job is to be honest about what happens when it is submitted, which is
 * **nothing yet**. A write-off is the one way to make stock disappear without anything
 * leaving the building, so §7 puts it behind a second person — and a screen that says
 * "saved" would be describing a different system. So the confirmation names the
 * approval, and the row carries "waiting for approval" until a checker decides.
 *
 * There is no value field on the form, and that absence is the control rather than a
 * simplification: the server multiplies the quantity by the weighted average it holds
 * (D-072). A value somebody could type is a value somebody could type as one taka, and
 * every approval threshold in the org would then be advisory.
 *
 * `stockValuePoisha` is rendered only when it is present. It is in `COST_FIELDS`, so a
 * warehouse role — the role that raises most write-offs — receives the row without it,
 * and `<Money>` on an absent value would print a broken amount to exactly the person
 * who should not see the figure at all.
 */

const STATUS_TONE: Readonly<Record<AdjustmentRow['status'], 'warning' | 'success' | 'neutral'>> = {
  pending_approval: 'warning',
  posted: 'success',
  rejected: 'neutral',
};

export function StockAdjustmentsPage() {
  const ability = useAbility();
  const st = useStockT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'StockAdjustment');
  const mayRequest = ability.can('request', 'StockAdjustment');

  const [locationId, setLocationId] = useState('');
  const [direction, setDirection] = useState<'loss' | 'gain'>('loss');
  const [skuId, setSkuId] = useState('');
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState('');
  const [raised, setRaised] = useState<string | null>(null);

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  });

  /**
   * The SKUs actually at the chosen location, so the form offers a code rather than
   * asking for a uuid.
   *
   * Scoped to the location on purpose: a write-off names stock that is *there*, and a
   * picker listing the whole catalogue invites a request for units the shelf has never
   * held — which the server refuses, correctly, after the person has typed a reason.
   */
  const stockHere = useQuery({
    queryKey: ['stock', 'levels', 'for-adjustment', locationId],
    queryFn: () => listStock({ locationId, page: 1, pageSize: 200 }),
    enabled: locationId !== '',
  });

  const adjustments = useQuery({
    queryKey: ['stock', 'adjustments'],
    queryFn: () => listAdjustments(),
    enabled: mayRead,
  });

  const reconciliations = useQuery({
    queryKey: ['stock', 'reconciliations'],
    queryFn: listReconciliations,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const submit = useMutation({
    mutationFn: () =>
      requestAdjustment({
        locationId,
        direction,
        reason,
        lines: [{ skuId, qty: Number(qty) }],
      }),
    onSuccess: (row) => {
      setRaised(row.approvalId);
      setSkuId('');
      setQty('1');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['stock'] });
    },
  });

  const canSubmit =
    locationId !== '' &&
    skuId !== '' &&
    reason.trim() !== '' &&
    Number(qty) > 0 &&
    !submit.isPending;

  return (
    <PermissionGate
      allowed={mayRead || mayRequest}
      explain={{ title: st('stock.deniedTitle'), detail: st('stock.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{st('stock.adjustments')}</h1>
          <p className="text-sm text-muted-foreground">{st('stock.adjustmentsHint')}</p>
        </header>

        <StockNav />

        <PermissionGate allowed={mayRequest}>
          <form
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate();
            }}
          >
            <Field label={st('stock.location')} id="adjustment-location">
              <select
                id="adjustment-location"
                value={locationId}
                required
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{st('stock.allLocations')}</option>
                {(locations.data?.items ?? []).map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.code} · {location.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={st('stock.direction')} id="adjustment-direction">
              <select
                id="adjustment-direction"
                value={direction}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setDirection(event.target.value === 'gain' ? 'gain' : 'loss')}
              >
                <option value="loss">{st('stock.direction.loss')}</option>
                <option value="gain">{st('stock.direction.gain')}</option>
              </select>
            </Field>

            <Field label={st('stock.sku')} id="adjustment-sku">
              <select
                id="adjustment-sku"
                value={skuId}
                required
                disabled={locationId === ''}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onChange={(event) => setSkuId(event.target.value)}
              >
                <option value="">{st('stock.sku')}</option>
                {(stockHere.data?.items ?? []).map((row) => (
                  <option key={row.skuId} value={row.skuId}>
                    {row.skuCode} · {row.productName} ({row.available})
                  </option>
                ))}
              </select>
            </Field>

            <Field label={st('stock.qty')} id="adjustment-qty">
              <input
                id="adjustment-qty"
                type="number"
                min={1}
                step={1}
                value={qty}
                required
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setQty(event.target.value)}
              />
            </Field>

            <Field label={st('stock.reason')} id="adjustment-reason" hint={st('stock.reasonHint')}>
              <input
                id="adjustment-reason"
                value={reason}
                required
                maxLength={500}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>

            <div className="flex items-end gap-3 sm:col-span-2">
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {st('stock.submit')}
              </Button>
              {raised !== null ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {st('stock.awaitingApproval')}
                </p>
              ) : null}
              {submit.error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {submit.error instanceof ApiError ? submit.error.message : st('stock.saveFailed')}
                </p>
              ) : null}
            </div>
          </form>
        </PermissionGate>

        <PermissionGate allowed={mayRead}>
          <section aria-label={st('stock.adjustments')} className="space-y-2">
            <table className="w-full text-sm">
              <caption className="sr-only">{st('stock.adjustments')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {st('stock.colDate')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('stock.direction')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('stock.colReason')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('stock.colValue')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('stock.colStatus')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(adjustments.data?.items ?? []).map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2 tabular-nums">{row.businessDate}</td>
                    <td className="py-2">
                      {st(`stock.direction.${row.direction}` as StockMessageKey)}
                    </td>
                    <td className="py-2">{row.reason}</td>
                    <td className="py-2 text-right">
                      {row.stockValuePoisha === undefined ? (
                        '—'
                      ) : (
                        <Money poisha={row.stockValuePoisha} />
                      )}
                    </td>
                    <td className="py-2">
                      <StatusBadge tone={STATUS_TONE[row.status]}>
                        {st(`stock.status.${row.status}` as StockMessageKey)}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(adjustments.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{st('stock.emptyTitle')}</p>
            ) : null}
          </section>

          <section aria-label={st('stock.reconciliations')} className="space-y-2">
            <h2 className="text-sm font-semibold">{st('stock.reconciliations')}</h2>
            <p className="text-sm text-muted-foreground">{st('stock.reconciliationsHint')}</p>
            <ul className="space-y-1 text-sm">
              {(reconciliations.data?.items ?? []).map((row) => (
                <li key={row.id} className="flex items-center gap-3">
                  <span className="tabular-nums">{row.businessDate}</span>
                  <span className="text-muted-foreground">
                    {st('stock.colChecked')}: {row.levelsChecked}
                  </span>
                  {row.driftCount === 0 && row.costDriftCount === 0 ? (
                    <StatusBadge tone="success">{st('stock.noDrift')}</StatusBadge>
                  ) : (
                    <StatusBadge tone="danger">
                      {st('stock.colDrift')}: {row.driftCount + row.costDriftCount}
                    </StatusBadge>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </PermissionGate>
      </div>
    </PermissionGate>
  );
}

function Field({
  label,
  id,
  hint,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
