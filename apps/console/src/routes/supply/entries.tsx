import { Button, Money, PermissionGate, StatusBadge, takaToPoisha } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { searchSkus } from '../catalog/api.js';
import { requestKey } from '../catalog/variant-grid.js';
import {
  createDraft,
  createEntry,
  deleteDraft,
  getEntry,
  listEntries,
  listLocations,
  listStock,
  listSupplierOptions,
  receiveEntry,
} from './api.js';
import { useSupplyT, type SupplyMessageKey } from './messages.js';
import { control, Field, numericControl, SupplyNav } from './supply-nav.js';

/**
 * Supply entries: the qty-only draft and the priced receipt (D-005).
 *
 * **The form a person sees depends on what they may do, and the two forms are different
 * shapes rather than one form with a hidden field.** A warehouse clerk gets quantities
 * and no price column, because `create Supply` without `read Cost` is exactly the role
 * D-005 describes and a disabled cost input would be a cost input. Accounts gets the
 * price column and the Receive button, because `read Cost` is what §6 means by "supply
 * entries, suppliers" for the finance team.
 *
 * The total is computed in the browser for the person filling the form and sent nowhere.
 * The server sums the lines itself — a header total that travels is a number that can
 * disagree with the lines it came from, and the disagreement would land in inventory
 * while the supplier was credited the other figure.
 *
 * Every cost is typed in **taka** (plan `catalog-stock-ux`, D-430) and converted to
 * poisha by `takaToPoisha`, which parses the digits as integers and refuses more than two
 * decimals, so no float is involved (invariant 1). It used to be typed in poisha, which
 * meant an owner pricing a ৳1,180.50 shirt had to type 118050.
 */

interface DraftLine {
  readonly key: string;
  skuId: string;
  qty: string;
  /** Taka as typed; converted by `takaToPoisha` when sent. */
  unitCostTaka: string;
}

const STATUS_TONE: Readonly<Record<'draft' | 'received', 'warning' | 'success'>> = {
  draft: 'warning',
  received: 'success',
};

let nextKey = 0;
function blankLine(): DraftLine {
  nextKey += 1;
  return { key: `line-${String(nextKey)}`, skuId: '', qty: '1', unitCostTaka: '' };
}

export function SupplyEntriesPage() {
  const ability = useAbility();
  const st = useSupplyT();
  const t = useT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Supply');
  const mayDraft = ability.can('create', 'Supply');
  const mayPrice = ability.can('read', 'Cost');

  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [done, setDone] = useState<'entry' | 'draft' | null>(null);
  /** The draft accounts is pricing, if any. Null while the main form is in use. */
  const [pricing, setPricing] = useState<string | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});

  /*
   * The picker reads `GET /v1/supply/supplier-options` (`create Supply`, D-419): ids, codes
   * and names only. Warehouse drafts deliveries without `read Supply`, so the full supplier
   * list answered 403 and the dropdown was empty for the role whose form this is.
   */
  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', 'options'],
    queryFn: listSupplierOptions,
    enabled: mayDraft,
    staleTime: 5 * 60_000,
  });

  const locations = useQuery({
    queryKey: ['supply', 'locations'],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  });

  /**
   * The SKUs the chosen location holds, so the form offers a code rather than a uuid.
   *
   * A picker over the whole catalogue would invite a line for a SKU this warehouse has
   * never held — which is legal for a *first* receipt, so the list is a convenience and
   * not a constraint: the field stays free for a SKU that is not on it yet.
   */
  const stock = useQuery({
    queryKey: ['supply', 'stock', locationId],
    queryFn: () => listStock({ locationId }),
    enabled: locationId !== '',
  });

  /*
   * The catalogue as well (plan `catalog-stock-ux`, D-430). The list above holds only SKUs
   * the location already stocks, so a new product's first delivery had no line to pick —
   * receiving it was impossible from this screen. The first 200 SKUs by code, plus
   * whatever the find box matches.
   */
  const [find, setFind] = useState('');
  const catalogue = useQuery({
    queryKey: ['supply', 'catalog-skus', find.trim().length >= 3 ? find.trim() : ''],
    queryFn: () => searchSkus(find.trim().length >= 3 ? find.trim() : '', 200),
    enabled: mayDraft || mayPrice,
    staleTime: 60_000,
  });
  const options = [
    ...(stock.data?.items ?? []).map((row) => ({
      skuId: row.skuId,
      label: `${row.skuCode} · ${row.productName}`,
    })),
    ...(catalogue.data?.items ?? [])
      .filter((row) => row.status === 'active')
      .map((row) => ({ skuId: row.id, label: `${row.skuCode} · ${row.name}` })),
  ].filter((row, index, all) => all.findIndex((other) => other.skuId === row.skuId) === index);

  const entries = useQuery({
    queryKey: ['supply', 'entries'],
    queryFn: () => listEntries(),
    enabled: mayRead,
  });

  const totalPoisha = lines.reduce((sum, line) => {
    const qty = BigInt(Number.isInteger(Number(line.qty)) ? Math.max(Number(line.qty), 0) : 0);
    const parsed = takaToPoisha(line.unitCostTaka);
    const cost = parsed === null ? 0n : BigInt(parsed);
    return sum + qty * cost;
  }, 0n);

  // One key per entry or draft being saved, kept across retries (ledger audit H1): a
  // retry after a lost response replays the first receipt instead of posting a second.
  const [key] = useState(() => requestKey());

  function reset(): void {
    key.settle();
    setLines([blankLine()]);
    setInvoiceNumber('');
    void queryClient.invalidateQueries({ queryKey: ['supply'] });
  }

  const submitEntry = useMutation({
    mutationFn: () =>
      createEntry({
        supplyId: key.for(
          JSON.stringify([
            supplierId,
            locationId,
            lines.map((line) => [line.skuId, line.qty, line.unitCostTaka]),
          ]),
        ),
        supplierId,
        locationId,
        ...(invoiceNumber.trim() === '' ? {} : { invoiceNumber: invoiceNumber.trim() }),
        lines: lines.map((line) => ({
          skuId: line.skuId,
          qty: Number(line.qty),
          unitCostPoisha: takaToPoisha(line.unitCostTaka) ?? '',
        })),
      }),
    onSuccess: () => {
      setDone('entry');
      reset();
    },
  });

  const submitDraft = useMutation({
    mutationFn: () =>
      createDraft({
        draftId: key.for(
          JSON.stringify([supplierId, locationId, lines.map((line) => [line.skuId, line.qty])]),
        ),
        supplierId,
        locationId,
        ...(invoiceNumber.trim() === '' ? {} : { invoiceNumber: invoiceNumber.trim() }),
        lines: lines.map((line) => ({ skuId: line.skuId, qty: Number(line.qty) })),
      }),
    onSuccess: () => {
      setDone('draft');
      reset();
    },
  });

  /**
   * The draft being priced, loaded from the server rather than from the list.
   *
   * The list carries no lines, and pricing needs every one of them: the server refuses a
   * receipt where any line is unpriced, naming the SKU, so the form has to show them all
   * or the person is told about a line they were never offered.
   */
  const draft = useQuery({
    queryKey: ['supply', 'entry', pricing],
    queryFn: () => getEntry(pricing ?? ''),
    enabled: pricing !== null && mayPrice,
  });

  const price = useMutation({
    mutationFn: () =>
      receiveEntry(pricing ?? '', {
        lines: (draft.data?.lines ?? []).map((line) => ({
          skuId: line.skuId,
          unitCostPoisha: takaToPoisha(prices[line.skuId] ?? '') ?? '',
        })),
      }),
    onSuccess: () => {
      setPricing(null);
      setPrices({});
      setDone('entry');
      void queryClient.invalidateQueries({ queryKey: ['supply'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteDraft(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['supply'] }),
  });

  const linesReady = lines.every(
    (line) =>
      line.skuId !== '' &&
      Number(line.qty) > 0 &&
      (!mayPrice || takaToPoisha(line.unitCostTaka) !== null),
  );
  const canSubmit = supplierId !== '' && locationId !== '' && linesReady;
  const pending = submitEntry.isPending || submitDraft.isPending;
  const error = submitEntry.error ?? submitDraft.error;

  return (
    <PermissionGate
      allowed={mayRead || mayDraft}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{st('supply.entries')}</h1>
          <p className="text-sm text-muted-foreground">
            {mayPrice ? st('supply.newEntryHint') : st('supply.newDraftHint')}
          </p>
        </header>

        <SupplyNav />

        <PermissionGate allowed={mayDraft || mayPrice}>
          <form
            className="space-y-3 rounded-lg border border-border bg-card p-4"
            onSubmit={(event) => {
              event.preventDefault();
              setDone(null);
              if (mayPrice) submitEntry.mutate();
              else submitDraft.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={st('supply.supplier')} id="entry-supplier">
                <select
                  id="entry-supplier"
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

              <Field label={st('supply.location')} id="entry-location">
                <select
                  id="entry-location"
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

              <Field label={st('supply.invoice')} id="entry-invoice">
                <input
                  id="entry-invoice"
                  value={invoiceNumber}
                  maxLength={64}
                  className={control}
                  onChange={(event) => setInvoiceNumber(event.target.value)}
                />
              </Field>
            </div>

            <Field label={t('cs.findItem')} id="entry-find">
              <input
                id="entry-find"
                type="search"
                value={find}
                maxLength={80}
                placeholder={t('cs.findItemHint')}
                className={control}
                onChange={(event) => setFind(event.target.value)}
              />
            </Field>

            <table className="w-full text-sm">
              <caption className="sr-only">{st('supply.lines')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {st('supply.sku')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('supply.qty')}
                  </th>
                  {mayPrice ? (
                    <th scope="col" className="py-2 text-right">
                      {t('cs.unitCostTaka')}
                    </th>
                  ) : null}
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={line.key} className="border-b border-border/60">
                    <td className="py-2">
                      <label className="sr-only" htmlFor={`${line.key}-sku`}>
                        {st('supply.sku')}
                      </label>
                      <select
                        id={`${line.key}-sku`}
                        value={line.skuId}
                        required
                        disabled={locationId === ''}
                        className={control}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((row, position) =>
                              position === index ? { ...row, skuId: event.target.value } : row,
                            ),
                          )
                        }
                      >
                        <option value="">{st('supply.sku')}</option>
                        {options.map((row) => (
                          <option key={row.skuId} value={row.skuId}>
                            {row.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2">
                      <label className="sr-only" htmlFor={`${line.key}-qty`}>
                        {st('supply.qty')}
                      </label>
                      <input
                        id={`${line.key}-qty`}
                        type="number"
                        min={1}
                        step={1}
                        value={line.qty}
                        required
                        className={numericControl}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((row, position) =>
                              position === index ? { ...row, qty: event.target.value } : row,
                            ),
                          )
                        }
                      />
                    </td>
                    {mayPrice ? (
                      <td className="py-2">
                        <label className="sr-only" htmlFor={`${line.key}-cost`}>
                          {t('cs.unitCostTaka')}
                        </label>
                        <input
                          id={`${line.key}-cost`}
                          // Taka, up to two decimals; `takaToPoisha` converts it with
                          // integer arithmetic (invariant 1).
                          inputMode="decimal"
                          value={line.unitCostTaka}
                          required
                          className={numericControl}
                          onChange={(event) =>
                            setLines((current) =>
                              current.map((row, position) =>
                                position === index
                                  ? { ...row, unitCostTaka: event.target.value }
                                  : row,
                              ),
                            )
                          }
                        />
                      </td>
                    ) : null}
                    <td className="py-2 text-right">
                      {lines.length > 1 ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setLines((current) =>
                              current.filter((_, position) => position !== index),
                            )
                          }
                        >
                          {st('supply.removeLine')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setLines((current) => [...current, blankLine()])}
              >
                {st('supply.addLine')}
              </Button>
              {mayPrice ? (
                <p className="text-sm text-muted-foreground">
                  {st('supply.total')}: <Money poisha={totalPoisha.toString()} />
                </p>
              ) : null}
              <Button type="submit" size="sm" disabled={!canSubmit || pending}>
                {mayPrice ? st('supply.priceAndReceive') : st('supply.newDraft')}
              </Button>
              {done !== null ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {done === 'entry' ? st('supply.entryPosted') : st('supply.draftSaved')}
                </p>
              ) : null}
              {error != null ? (
                <p role="alert" className="text-sm text-destructive">
                  {error instanceof ApiError ? error.message : st('supply.saveFailed')}
                </p>
              ) : null}
            </div>
          </form>
        </PermissionGate>

        {pricing === null ? null : (
          <form
            className="space-y-3 rounded-lg border border-border bg-card p-4"
            onSubmit={(event) => {
              event.preventDefault();
              price.mutate();
            }}
          >
            <h2 className="text-sm font-semibold">{st('supply.priceAndReceive')}</h2>
            <table className="w-full text-sm">
              <caption className="sr-only">{st('supply.lines')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {st('supply.sku')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('supply.qty')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('cs.unitCostTaka')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(draft.data?.lines ?? []).map((line) => (
                  <tr key={line.id} className="border-b border-border/60">
                    <td className="py-2">
                      {line.skuCode} · {line.productName}
                    </td>
                    <td className="py-2 text-right tabular-nums">{line.qty}</td>
                    <td className="py-2">
                      <label className="sr-only" htmlFor={`price-${line.id}`}>
                        {t('cs.unitCostTaka')}
                      </label>
                      <input
                        id={`price-${line.id}`}
                        inputMode="decimal"
                        required
                        value={prices[line.skuId] ?? ''}
                        className={numericControl}
                        onChange={(event) =>
                          setPrices((current) => ({
                            ...current,
                            [line.skuId]: event.target.value,
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" disabled={price.isPending}>
                {st('supply.receive')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPricing(null);
                  setPrices({});
                }}
              >
                {st('supply.removeLine')}
              </Button>
              {price.error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {price.error instanceof ApiError ? price.error.message : st('supply.saveFailed')}
                </p>
              ) : null}
            </div>
          </form>
        )}

        <PermissionGate allowed={mayRead}>
          <section aria-label={st('supply.entries')} className="space-y-2">
            <table className="w-full text-sm">
              <caption className="sr-only">{st('supply.entries')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {st('supply.colDate')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.supplier')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.invoice')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.colStatus')}
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {(entries.data?.items ?? []).map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2 tabular-nums">{row.businessDate ?? '—'}</td>
                    <td className="py-2">{row.supplierName}</td>
                    <td className="py-2 tabular-nums">{row.invoiceNumber ?? '—'}</td>
                    <td className="py-2">
                      <StatusBadge tone={STATUS_TONE[row.status]}>
                        {st(`supply.status.${row.status}` as SupplyMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className="py-2 text-right">
                      {row.status === 'draft' && mayPrice ? (
                        <span className="flex justify-end gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setPricing(row.id);
                              setPrices({});
                            }}
                          >
                            {st('supply.receive')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(row.id)}
                          >
                            {st('supply.deleteDraft')}
                          </Button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(entries.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
            ) : null}
          </section>
        </PermissionGate>
      </div>
    </PermissionGate>
  );
}
