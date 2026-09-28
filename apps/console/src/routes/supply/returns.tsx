import { Button, Money, PermissionGate } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { createReturn, listLocations, listReturns, listStock, listSuppliers } from './api.js';
import { useSupplyT } from './messages.js';
import { control, Field, numericControl, SupplyNav } from './supply-nav.js';

/**
 * Returns to a supplier (§8): out at the average, credited at the original cost.
 *
 * The form asks for the **original** unit cost and never for the average, and the hint
 * explains why in the terms a purchasing person cares about: the supplier credits what
 * their invoice said, the shelf gives up what the units are carried at, and the gap is a
 * real gain or loss that goes to purchase price variance. An average field here would let
 * that variance be made to disappear by typing the number that makes it zero — so the
 * server reads the average off the movement it creates, under the cost row's lock.
 *
 * The table therefore shows three money columns rather than one, and the two that are not
 * the supplier's credit come from the journal: what left stock and what the difference
 * was. That is the whole point of the rule, and a list showing only the credit would hide
 * it.
 */
export function SupplyReturnsPage() {
  const ability = useAbility();
  const st = useSupplyT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Supply');
  const mayReturn = ability.can('read', 'Cost');

  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [skuId, setSkuId] = useState('');
  const [qty, setQty] = useState('1');
  const [originalUnitCostPoisha, setOriginalUnitCostPoisha] = useState('');
  const [reason, setReason] = useState('');

  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', 'picker'],
    queryFn: () => listSuppliers(),
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const locations = useQuery({
    queryKey: ['supply', 'locations'],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  });

  const stock = useQuery({
    queryKey: ['supply', 'stock', locationId],
    queryFn: () => listStock({ locationId }),
    enabled: locationId !== '',
  });

  const returns = useQuery({
    queryKey: ['supply', 'returns'],
    queryFn: () => listReturns(),
    enabled: mayRead,
  });

  const submit = useMutation({
    mutationFn: () =>
      createReturn({
        returnId: crypto.randomUUID(),
        supplierId,
        locationId,
        reason: reason.trim(),
        lines: [{ skuId, qty: Number(qty), originalUnitCostPoisha }],
      }),
    onSuccess: () => {
      setSkuId('');
      setQty('1');
      setOriginalUnitCostPoisha('');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['supply'] });
    },
  });

  const canSubmit =
    supplierId !== '' &&
    locationId !== '' &&
    skuId !== '' &&
    Number(qty) > 0 &&
    /^\d+$/.test(originalUnitCostPoisha) &&
    reason.trim() !== '' &&
    !submit.isPending;

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{st('supply.returns')}</h1>
          <p className="text-sm text-muted-foreground">{st('supply.returnHint')}</p>
        </header>

        <SupplyNav />

        <PermissionGate allowed={mayReturn}>
          <form
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate();
            }}
          >
            <Field label={st('supply.supplier')} id="return-supplier">
              <select
                id="return-supplier"
                value={supplierId}
                required
                className={control}
                onChange={(event) => setSupplierId(event.target.value)}
              >
                <option value="">{st('supply.supplier')}</option>
                {(suppliers.data?.items ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code} · {row.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={st('supply.location')} id="return-location">
              <select
                id="return-location"
                value={locationId}
                required
                className={control}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{st('supply.location')}</option>
                {(locations.data?.items ?? [])
                  .filter((place) => place.kind === 'warehouse' || place.kind === 'showroom')
                  .map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.code} · {place.name}
                    </option>
                  ))}
              </select>
            </Field>

            <Field label={st('supply.sku')} id="return-sku">
              <select
                id="return-sku"
                value={skuId}
                required
                disabled={locationId === ''}
                className={control}
                onChange={(event) => setSkuId(event.target.value)}
              >
                <option value="">{st('supply.sku')}</option>
                {(stock.data?.items ?? []).map((row) => (
                  <option key={row.skuId} value={row.skuId}>
                    {row.skuCode} · {row.productName} ({row.available})
                  </option>
                ))}
              </select>
            </Field>

            <Field label={st('supply.qty')} id="return-qty">
              <input
                id="return-qty"
                type="number"
                min={1}
                step={1}
                value={qty}
                required
                className={numericControl}
                onChange={(event) => setQty(event.target.value)}
              />
            </Field>

            <Field label={st('supply.originalUnitCost')} id="return-cost">
              <input
                id="return-cost"
                inputMode="numeric"
                pattern="\d*"
                value={originalUnitCostPoisha}
                required
                className={numericControl}
                onChange={(event) => setOriginalUnitCostPoisha(event.target.value)}
              />
            </Field>

            <Field label={st('supply.reason')} id="return-reason">
              <input
                id="return-reason"
                value={reason}
                required
                maxLength={500}
                className={control}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {st('supply.newReturn')}
              </Button>
              {submit.error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {submit.error instanceof ApiError
                    ? submit.error.message
                    : st('supply.saveFailed')}
                </p>
              ) : null}
            </div>
          </form>
        </PermissionGate>

        <section aria-label={st('supply.returns')} className="space-y-2">
          <table className="w-full text-sm">
            <caption className="sr-only">{st('supply.returns')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2">
                  {st('supply.colDate')}
                </th>
                <th scope="col" className="py-2">
                  {st('supply.supplier')}
                </th>
                <th scope="col" className="py-2">
                  {st('supply.reason')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {st('supply.colCredited')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {st('supply.colRelief')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {st('supply.colVariance')}
                </th>
              </tr>
            </thead>
            <tbody>
              {(returns.data?.items ?? []).map((row) => (
                <tr key={row.id} className="border-b border-border/60">
                  <td className="py-2 tabular-nums">{row.businessDate}</td>
                  <td className="py-2">{row.supplierName}</td>
                  <td className="py-2">{row.reason}</td>
                  <td className="py-2 text-right">
                    {row.creditPoisha === undefined ? '—' : <Money poisha={row.creditPoisha} />}
                  </td>
                  <td className="py-2 text-right">
                    {row.reliefPoisha === undefined ? '—' : <Money poisha={row.reliefPoisha} />}
                  </td>
                  <td className="py-2 text-right">
                    {row.variancePoisha === undefined ? '—' : <Money poisha={row.variancePoisha} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(returns.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
          ) : null}
        </section>
      </div>
    </PermissionGate>
  );
}
