import { Button, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  dispatchTransfer,
  listLocations,
  listStock,
  listTransfers,
  receiveTransfer,
} from './api.js';
import { StockNav } from './stock-nav.js';
import { useStockT, type StockMessageKey } from './messages.js';

/**
 * Two-step transfers (M07 Build list).
 *
 * The screen shows both steps as steps, because the gap between them is the whole
 * point: after dispatch the stock is in the org's in-transit location — a real place
 * with a real quantity — and it stays there until somebody at the destination receives
 * it. A single "move stock" button would make the difference between "in transit" and
 * "lost" a thing nobody can see.
 *
 * The destination picker deliberately does not filter by branch. Sending stock to
 * another branch is the ordinary case, and a showroom returning stock to the warehouse
 * is the second most ordinary; the scope check that matters is on the **source**, which
 * the server applies, because that is the shelf the units leave.
 */

export function StockTransfersPage() {
  const ability = useAbility();
  const st = useStockT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Stock');
  const mayTransfer = ability.can('request', 'StockAdjustment');

  const [fromLocationId, setFrom] = useState('');
  const [toLocationId, setTo] = useState('');
  const [skuId, setSkuId] = useState('');
  const [qty, setQty] = useState('1');

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  });

  const transfers = useQuery({
    queryKey: ['stock', 'transfers'],
    queryFn: () => listTransfers(),
    enabled: mayRead,
  });

  const stockHere = useQuery({
    queryKey: ['stock', 'levels', 'for-transfer', fromLocationId],
    queryFn: () => listStock({ locationId: fromLocationId, page: 1, pageSize: 200 }),
    enabled: fromLocationId !== '',
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['stock'] });

  const dispatch = useMutation({
    mutationFn: () =>
      dispatchTransfer({
        fromLocationId,
        toLocationId,
        lines: [{ skuId, qty: Number(qty) }],
      }),
    onSuccess: () => {
      setSkuId('');
      setQty('1');
      refresh();
    },
  });

  const receive = useMutation({
    mutationFn: (id: string) => receiveTransfer(id),
    onSuccess: refresh,
  });

  const failure = [dispatch.error, receive.error].find((error) => error != null);
  const selectable = (locations.data?.items ?? []).filter(
    // In-transit is where a transfer passes through, not an end of one — the server
    // refuses it, and offering it would be offering a 409.
    (location) => location.kind !== 'in_transit',
  );

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('stock.deniedTitle'), detail: st('stock.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{st('stock.transfers')}</h1>
          <p className="text-sm text-muted-foreground">{st('stock.transfersHint')}</p>
        </header>

        <StockNav />

        <PermissionGate allowed={mayTransfer}>
          <form
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              dispatch.mutate();
            }}
          >
            <div className="space-y-1">
              <label htmlFor="transfer-from" className="text-xs font-medium text-muted-foreground">
                {st('stock.from')}
              </label>
              <select
                id="transfer-from"
                value={fromLocationId}
                required
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setFrom(event.target.value)}
              >
                <option value="">{st('stock.allLocations')}</option>
                {selectable.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.code} · {location.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="transfer-to" className="text-xs font-medium text-muted-foreground">
                {st('stock.to')}
              </label>
              <select
                id="transfer-to"
                value={toLocationId}
                required
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setTo(event.target.value)}
              >
                <option value="">{st('stock.allLocations')}</option>
                {selectable
                  .filter((location) => location.id !== fromLocationId)
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.code} · {location.name}
                    </option>
                  ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="transfer-sku" className="text-xs font-medium text-muted-foreground">
                {st('stock.sku')}
              </label>
              <select
                id="transfer-sku"
                value={skuId}
                required
                disabled={fromLocationId === ''}
                className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                onChange={(event) => setSkuId(event.target.value)}
              >
                <option value="">{st('stock.sku')}</option>
                {(stockHere.data?.items ?? []).map((row) => (
                  <option key={row.skuId} value={row.skuId}>
                    {row.skuCode} ({row.available})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="transfer-qty" className="text-xs font-medium text-muted-foreground">
                {st('stock.qty')}
              </label>
              <div className="flex gap-2">
                <input
                  id="transfer-qty"
                  type="number"
                  min={1}
                  step={1}
                  value={qty}
                  required
                  className="h-8 w-20 rounded-md border border-border bg-background px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => setQty(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    fromLocationId === '' ||
                    toLocationId === '' ||
                    skuId === '' ||
                    dispatch.isPending
                  }
                >
                  {st('stock.dispatch')}
                </Button>
              </div>
            </div>
          </form>
        </PermissionGate>

        {failure != null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure instanceof ApiError ? failure.message : st('stock.saveFailed')}
          </p>
        ) : null}

        <section aria-label={st('stock.transfers')} className="space-y-2">
          <table className="w-full text-sm">
            <caption className="sr-only">{st('stock.transfers')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2">
                  {st('stock.from')}
                </th>
                <th scope="col" className="py-2">
                  {st('stock.to')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {st('stock.qty')}
                </th>
                <th scope="col" className="py-2">
                  {st('stock.colStatus')}
                </th>
                <th scope="col" className="py-2" />
              </tr>
            </thead>
            <tbody>
              {(transfers.data?.items ?? []).map((row) => {
                const code = (id: string) =>
                  locations.data?.items.find((location) => location.id === id)?.code ?? id;
                const units = row.lines.reduce((total, line) => total + line.qty, 0);
                return (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2">{code(row.fromLocationId)}</td>
                    <td className="py-2">{code(row.toLocationId)}</td>
                    <td className="py-2 text-right tabular-nums">{units}</td>
                    <td className="py-2">
                      <StatusBadge
                        tone={
                          row.status === 'dispatched'
                            ? 'info'
                            : row.status === 'received'
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {st(`stock.status.${row.status}` as StockMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className="py-2 text-right">
                      <PermissionGate allowed={mayTransfer && row.status === 'dispatched'}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={receive.isPending}
                          onClick={() => receive.mutate(row.id)}
                        >
                          {st('stock.receive')}
                        </Button>
                      </PermissionGate>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(transfers.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{st('stock.emptyTitle')}</p>
          ) : null}
        </section>
      </div>
    </PermissionGate>
  );
}
