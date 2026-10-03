import {
  Button,
  EmptyState,
  Money,
  PermissionGate,
  Section,
  Select,
  Sheet,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Plus } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import {
  listAdjustments,
  listLocations,
  listReconciliations,
  listStock,
  requestAdjustment,
  type AdjustmentRow,
} from './api.js';
import {
  control,
  Field,
  StockHeader,
  TableFrame,
  TD,
  TD_NUM,
  TH,
  TH_NUM,
  TR,
} from './stock-nav.js';
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
  const t = useT();
  const queryClient = useQueryClient();
  // The request form opens in a sheet from the page's one action (D-447): the list of
  // adjustments is what most visits are for.
  const [formOpen, setFormOpen] = useState(false);

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
        <StockHeader
          title={st('stock.adjustments')}
          description={st('stock.adjustmentsHint')}
          actions={
            <PermissionGate allowed={mayRequest}>
              <Button onClick={() => setFormOpen(true)}>
                <Plus aria-hidden="true" />
                {st('stock.newAdjustment')}
              </Button>
            </PermissionGate>
          }
        />

        <PermissionGate allowed={mayRequest}>
          <Sheet
            open={formOpen}
            onOpenChange={setFormOpen}
            title={st('stock.newAdjustment')}
            description={st('stock.adjustmentsHint')}
            closeLabel={t('common.close')}
            footer={
              <>
                <Button variant="outline" onClick={() => setFormOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" form="stock-adjustment-form" disabled={!canSubmit}>
                  {st('stock.submit')}
                </Button>
              </>
            }
          >
            <form
              id="stock-adjustment-form"
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit.mutate();
              }}
            >
              <Field label={st('stock.location')} id="adjustment-location">
                <Select
                  id="adjustment-location"
                  value={locationId}
                  placeholder={st('stock.allLocations')}
                  options={(locations.data?.items ?? []).map((location) => ({
                    value: location.id,
                    label: `${location.code} · ${location.name}`,
                  }))}
                  onValueChange={setLocationId}
                />
              </Field>

              <Field label={st('stock.direction')} id="adjustment-direction">
                <Select
                  id="adjustment-direction"
                  value={direction}
                  options={[
                    { value: 'loss', label: st('stock.direction.loss') },
                    { value: 'gain', label: st('stock.direction.gain') },
                  ]}
                  onValueChange={(value) => setDirection(value === 'gain' ? 'gain' : 'loss')}
                />
              </Field>

              <Field label={st('stock.sku')} id="adjustment-sku">
                <Select
                  id="adjustment-sku"
                  value={skuId}
                  placeholder={st('stock.sku')}
                  disabled={locationId === ''}
                  options={(stockHere.data?.items ?? []).map((row) => ({
                    value: row.skuId,
                    label: `${row.skuCode} · ${row.productName} (${String(row.available)})`,
                  }))}
                  onValueChange={setSkuId}
                />
              </Field>

              <Field label={st('stock.qty')} id="adjustment-qty">
                <input
                  id="adjustment-qty"
                  type="number"
                  min={1}
                  step={1}
                  value={qty}
                  required
                  className={`${control} tabular-nums`}
                  onChange={(event) => setQty(event.target.value)}
                />
              </Field>

              <Field
                label={st('stock.reason')}
                id="adjustment-reason"
                hint={st('stock.reasonHint')}
              >
                <input
                  id="adjustment-reason"
                  value={reason}
                  required
                  maxLength={500}
                  className={control}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>

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
            </form>
          </Sheet>
        </PermissionGate>

        {/* Said on the page as well, so the person who closed the sheet still sees that
            nothing moves until a second person approves. */}
        {raised !== null && !formOpen ? (
          <p role="status" className="text-sm text-muted-foreground">
            {st('stock.awaitingApproval')}
          </p>
        ) : null}

        <PermissionGate allowed={mayRead}>
          <section aria-label={st('stock.adjustments')}>
            {(adjustments.data?.items ?? []).length === 0 ? (
              <EmptyState icon={ClipboardList} title={st('stock.emptyTitle')} />
            ) : (
              <TableFrame label={st('stock.adjustments')}>
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <caption className="sr-only">{st('stock.adjustments')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        {st('stock.colDate')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('stock.direction')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('stock.colReason')}
                      </th>
                      <th scope="col" className={TH_NUM}>
                        {st('stock.colValue')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('stock.colStatus')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(adjustments.data?.items ?? []).map((row) => (
                      <tr key={row.id} className={TR}>
                        <td className={`${TD} text-muted-foreground tabular-nums`}>
                          {row.businessDate}
                        </td>
                        <td className={TD}>
                          {st(`stock.direction.${row.direction}` as StockMessageKey)}
                        </td>
                        <td className={`${TD} whitespace-normal`}>{row.reason}</td>
                        <td className={TD_NUM}>
                          {row.stockValuePoisha === undefined ? (
                            '—'
                          ) : (
                            <Money poisha={row.stockValuePoisha} />
                          )}
                        </td>
                        <td className={TD}>
                          <StatusBadge tone={STATUS_TONE[row.status]}>
                            {st(`stock.status.${row.status}` as StockMessageKey)}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
          </section>

          <Section
            title={st('stock.reconciliations')}
            description={st('stock.reconciliationsHint')}
          >
            <ul aria-label={st('stock.reconciliations')} className="divide-y divide-border text-sm">
              {(reconciliations.data?.items ?? []).map((row) => (
                <li key={row.id} className="flex items-center gap-3 py-2.5">
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
          </Section>
        </PermissionGate>
      </div>
    </PermissionGate>
  );
}
