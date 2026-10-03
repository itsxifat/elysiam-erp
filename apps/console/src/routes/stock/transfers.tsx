import { Button, EmptyState, PermissionGate, Select, Sheet, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import {
  dispatchTransfer,
  listLocations,
  listStock,
  listTransfers,
  receiveTransfer,
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
  const t = useT();
  const queryClient = useQueryClient();
  // Sending stock opens in a sheet from the page's one action (D-447); receiving stays
  // on each row of the list, where the person at the destination looks for it.
  const [formOpen, setFormOpen] = useState(false);

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

  // Sending's failure is said inside its sheet; the page says receiving's.
  const failure = receive.error;
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
        <StockHeader
          title={st('stock.transfers')}
          description={st('stock.transfersHint')}
          actions={
            <PermissionGate allowed={mayTransfer}>
              <Button onClick={() => setFormOpen(true)}>
                <Plus aria-hidden="true" />
                {st('stock.newTransfer')}
              </Button>
            </PermissionGate>
          }
        />

        <PermissionGate allowed={mayTransfer}>
          <Sheet
            open={formOpen}
            onOpenChange={setFormOpen}
            title={st('stock.newTransfer')}
            description={st('stock.transfersHint')}
            closeLabel={t('common.close')}
            footer={
              <>
                <Button variant="outline" onClick={() => setFormOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  form="stock-transfer-form"
                  disabled={
                    fromLocationId === '' ||
                    toLocationId === '' ||
                    skuId === '' ||
                    dispatch.isPending
                  }
                >
                  {st('stock.dispatch')}
                </Button>
              </>
            }
          >
            <form
              id="stock-transfer-form"
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                dispatch.mutate();
              }}
            >
              <Field label={st('stock.from')} id="transfer-from">
                <Select
                  id="transfer-from"
                  value={fromLocationId}
                  placeholder={st('stock.allLocations')}
                  options={selectable.map((location) => ({
                    value: location.id,
                    label: `${location.code} · ${location.name}`,
                  }))}
                  onValueChange={setFrom}
                />
              </Field>

              <Field label={st('stock.to')} id="transfer-to">
                <Select
                  id="transfer-to"
                  value={toLocationId}
                  placeholder={st('stock.allLocations')}
                  options={selectable
                    .filter((location) => location.id !== fromLocationId)
                    .map((location) => ({
                      value: location.id,
                      label: `${location.code} · ${location.name}`,
                    }))}
                  onValueChange={setTo}
                />
              </Field>

              <Field label={st('stock.sku')} id="transfer-sku">
                <Select
                  id="transfer-sku"
                  value={skuId}
                  placeholder={st('stock.sku')}
                  disabled={fromLocationId === ''}
                  options={(stockHere.data?.items ?? []).map((row) => ({
                    value: row.skuId,
                    label: `${row.skuCode} (${String(row.available)})`,
                  }))}
                  onValueChange={setSkuId}
                />
              </Field>

              <Field label={st('stock.qty')} id="transfer-qty">
                <input
                  id="transfer-qty"
                  type="number"
                  min={1}
                  step={1}
                  value={qty}
                  required
                  className={`${control} w-28 tabular-nums`}
                  onChange={(event) => setQty(event.target.value)}
                />
              </Field>

              {dispatch.error != null ? (
                <p role="alert" className="text-sm text-destructive">
                  {dispatch.error instanceof ApiError
                    ? dispatch.error.message
                    : st('stock.saveFailed')}
                </p>
              ) : null}
            </form>
          </Sheet>
        </PermissionGate>

        {failure != null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure instanceof ApiError ? failure.message : st('stock.saveFailed')}
          </p>
        ) : null}

        <section aria-label={st('stock.transfers')}>
          {(transfers.data?.items ?? []).length === 0 ? (
            <EmptyState icon={ArrowLeftRight} title={st('stock.emptyTitle')} />
          ) : (
            <TableFrame label={st('stock.transfers')}>
              <table className="w-full border-separate border-spacing-0 text-sm">
                <caption className="sr-only">{st('stock.transfers')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      {st('stock.from')}
                    </th>
                    <th scope="col" className={TH}>
                      {st('stock.to')}
                    </th>
                    <th scope="col" className={TH_NUM}>
                      {st('stock.qty')}
                    </th>
                    <th scope="col" className={TH}>
                      {st('stock.colStatus')}
                    </th>
                    <th scope="col" className={TH} />
                  </tr>
                </thead>
                <tbody>
                  {(transfers.data?.items ?? []).map((row) => {
                    const code = (id: string) =>
                      locations.data?.items.find((location) => location.id === id)?.code ?? id;
                    const units = row.lines.reduce((total, line) => total + line.qty, 0);
                    return (
                      <tr key={row.id} className={TR}>
                        <td className={`${TD} font-medium`}>{code(row.fromLocationId)}</td>
                        <td className={`${TD} font-medium`}>{code(row.toLocationId)}</td>
                        <td className={TD_NUM}>{units}</td>
                        <td className={TD}>
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
                        <td className={`${TD} text-right`}>
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
            </TableFrame>
          )}
        </section>
      </div>
    </PermissionGate>
  );
}
