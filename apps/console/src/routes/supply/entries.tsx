import {
  Button,
  EmptyState,
  Money,
  PermissionGate,
  SearchInput,
  Section,
  Select,
  StatusBadge,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageOpen, Plus } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import { lookupCode, searchSkus } from '../catalog/api.js';
import { ScanField } from '../catalog/scan-field.js';
import { StickerDialog, type StickerItem } from '../catalog/stickers.js';
import { isReplayConflict, requestKey } from '../catalog/variant-grid.js';
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
import {
  control,
  Field,
  LoadingRows,
  numericControl,
  SupplyHeader,
  TableFrame,
  TD,
  TD_NUMERIC,
  TH,
  TH_NUMERIC,
  TR,
} from './supply-nav.js';

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
  // M38a: SKUs added by a scan (so the line's list offers them), the last scan's answer,
  // and the stickers a receipt offers, one per piece received (D-604, D-605).
  const [scannedOptions, setScannedOptions] = useState<{ skuId: string; label: string }[]>([]);
  const [scanMessage, setScanMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [stickers, setStickers] = useState<readonly StickerItem[] | null>(null);

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
    ...scannedOptions,
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

  /** One sticker per piece on the lines just saved, labelled as the line list shows them. */
  function offerStickers(): void {
    const items = lines
      .filter((line) => line.skuId !== '' && Number(line.qty) > 0)
      .map((line) => ({
        skuId: line.skuId,
        label: options.find((option) => option.skuId === line.skuId)?.label ?? line.skuId,
        skuCode: '',
        count: Number(line.qty),
      }));
    if (items.length > 0) setStickers(items);
  }

  /** A scan adds a line for that SKU, or one more piece on its line (D-605). */
  async function scan(code: string): Promise<void> {
    try {
      const found = await lookupCode(code);
      const label = `${found.sku.code} · ${found.product.name}${
        found.sku.variantLabel === '' ? '' : ` · ${found.sku.variantLabel}`
      }`;
      setScannedOptions((current) =>
        current.some((option) => option.skuId === found.sku.id)
          ? current
          : [...current, { skuId: found.sku.id, label }],
      );
      setLines((current) => {
        const existing = current.find((line) => line.skuId === found.sku.id);
        if (existing !== undefined) {
          return current.map((line) =>
            line === existing ? { ...line, qty: String((Number(line.qty) || 0) + 1) } : line,
          );
        }
        const blank = current.find((line) => line.skuId === '');
        if (blank !== undefined) {
          return current.map((line) =>
            line === blank ? { ...line, skuId: found.sku.id, qty: '1' } : line,
          );
        }
        return [...current, { ...blankLine(), skuId: found.sku.id, qty: '1' }];
      });
      setScanMessage({ text: `${t('st.scan.added')} ${label}`, error: false });
    } catch (scanError) {
      setScanMessage({
        text:
          scanError instanceof ApiError && scanError.status === 404
            ? t('st.scan.notFound')
            : t('st.scan.failed'),
        error: true,
      });
    }
  }

  function reset(): void {
    key.settle();
    setLines([blankLine()]);
    setInvoiceNumber('');
    void queryClient.invalidateQueries({ queryKey: ['supply'] });
  }

  const submitEntry = useMutation({
    mutationFn: () =>
      createEntry({
        supplyId: key.current(),
        supplierId,
        locationId,
        ...(invoiceNumber.trim() === '' ? {} : { invoiceNumber: invoiceNumber.trim() }),
        lines: lines.map((line) => ({
          skuId: line.skuId,
          qty: Number(line.qty),
          unitCostPoisha: takaToPoisha(line.unitCostTaka) ?? '',
        })),
      }),
    onError: (error) => {
      // Told an earlier save went through with other goods: the next press is new.
      if (isReplayConflict(error)) key.settle();
    },
    onSuccess: () => {
      setDone('entry');
      offerStickers();
      reset();
    },
  });

  const submitDraft = useMutation({
    mutationFn: () =>
      createDraft({
        draftId: key.current(),
        supplierId,
        locationId,
        ...(invoiceNumber.trim() === '' ? {} : { invoiceNumber: invoiceNumber.trim() }),
        lines: lines.map((line) => ({ skuId: line.skuId, qty: Number(line.qty) })),
      }),
    onError: (error) => {
      // Told an earlier save went through with other goods: the next press is new.
      if (isReplayConflict(error)) key.settle();
    },
    onSuccess: () => {
      setDone('draft');
      offerStickers();
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

  const supplierOptions = (suppliers.data?.items ?? []).map((row) => ({
    value: row.id,
    label: `${row.code} · ${row.name}`,
  }));
  const locationOptions = (locations.data?.items ?? [])
    .filter((place) => place.kind === 'warehouse' || place.kind === 'showroom')
    .map((place) => ({ value: place.id, label: `${place.code} · ${place.name}` }));
  const skuOptions = options.map((row) => ({ value: row.skuId, label: row.label }));
  const entryRows = entries.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead || mayDraft}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <SupplyHeader
          title={st('supply.entries')}
          description={mayPrice ? st('supply.newEntryHint') : st('supply.newDraftHint')}
        />

        <PermissionGate allowed={mayDraft || mayPrice}>
          <Section title={mayPrice ? st('supply.newEntry') : st('supply.newDraft')}>
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                setDone(null);
                if (mayPrice) submitEntry.mutate();
                else submitDraft.mutate();
              }}
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={st('supply.supplier')} id="entry-supplier">
                  <Select
                    id="entry-supplier"
                    value={supplierId}
                    required
                    placeholder={st('supply.supplier')}
                    options={supplierOptions}
                    onValueChange={setSupplierId}
                  />
                </Field>

                <Field label={st('supply.location')} id="entry-location">
                  <Select
                    id="entry-location"
                    value={locationId}
                    required
                    placeholder={st('supply.location')}
                    options={locationOptions}
                    onValueChange={setLocationId}
                  />
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

              <ScanField
                autoFocus={false}
                message={scanMessage?.text ?? null}
                tone={scanMessage?.error === true ? 'error' : 'neutral'}
                onCode={(code) => void scan(code)}
              />

              <Field label={t('cs.findItem')} id="entry-find">
                <SearchInput
                  id="entry-find"
                  value={find}
                  maxLength={80}
                  placeholder={t('cs.findItemHint')}
                  className="sm:w-full"
                  onChange={(event) => setFind(event.target.value)}
                />
              </Field>

              <TableFrame label={st('supply.lines')}>
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <caption className="sr-only">{st('supply.lines')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        {st('supply.sku')}
                      </th>
                      <th scope="col" className={`${TH_NUMERIC} w-32`}>
                        {st('supply.qty')}
                      </th>
                      {mayPrice ? (
                        <th scope="col" className={`${TH_NUMERIC} w-44`}>
                          {t('cs.unitCostTaka')}
                        </th>
                      ) : null}
                      <th scope="col" className={`${TH} w-px`}>
                        <span className="sr-only">{st('supply.removeLine')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={line.key} className={TR}>
                        <td className={`${TD} py-2`}>
                          <label className="sr-only" htmlFor={`${line.key}-sku`}>
                            {st('supply.sku')}
                          </label>
                          <Select
                            id={`${line.key}-sku`}
                            value={line.skuId}
                            required
                            disabled={locationId === ''}
                            placeholder={st('supply.sku')}
                            options={skuOptions}
                            onValueChange={(value) =>
                              setLines((current) =>
                                current.map((row, position) =>
                                  position === index ? { ...row, skuId: value } : row,
                                ),
                              )
                            }
                          />
                        </td>
                        <td className={`${TD} py-2`}>
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
                          <td className={`${TD} py-2`}>
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
                        <td className={`${TD} py-2 text-right`}>
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
              </TableFrame>

              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setLines((current) => [...current, blankLine()])}
                >
                  <Plus aria-hidden="true" />
                  {st('supply.addLine')}
                </Button>
                {mayPrice ? (
                  <p className="text-sm text-muted-foreground">
                    {st('supply.total')}:{' '}
                    <span className="font-medium text-foreground">
                      <Money poisha={totalPoisha.toString()} />
                    </span>
                  </p>
                ) : null}
                <Button type="submit" className="ml-auto" disabled={!canSubmit || pending}>
                  {mayPrice ? st('supply.priceAndReceive') : st('supply.newDraft')}
                </Button>
                {done !== null ? (
                  <p role="status" className="w-full text-sm text-muted-foreground">
                    {done === 'entry' ? st('supply.entryPosted') : st('supply.draftSaved')}
                  </p>
                ) : null}
                {error != null ? (
                  <p role="alert" className="w-full text-sm text-destructive">
                    {error instanceof ApiError ? error.message : st('supply.saveFailed')}
                  </p>
                ) : null}
              </div>
            </form>
          </Section>
        </PermissionGate>

        {pricing === null ? null : (
          <Section title={st('supply.priceAndReceive')}>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                price.mutate();
              }}
            >
              <TableFrame label={st('supply.lines')}>
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <caption className="sr-only">{st('supply.lines')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        {st('supply.sku')}
                      </th>
                      <th scope="col" className={TH_NUMERIC}>
                        {st('supply.qty')}
                      </th>
                      <th scope="col" className={`${TH_NUMERIC} w-44`}>
                        {t('cs.unitCostTaka')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(draft.data?.lines ?? []).map((line) => (
                      <tr key={line.id} className={TR}>
                        <td className={TD}>
                          <span className="font-medium tabular-nums">{line.skuCode}</span>
                          <span className="text-muted-foreground"> · {line.productName}</span>
                        </td>
                        <td className={TD_NUMERIC}>{line.qty}</td>
                        <td className={`${TD} py-2`}>
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
              </TableFrame>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={price.isPending}>
                  {st('supply.receive')}
                </Button>
                <Button
                  type="button"
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
                    {price.error instanceof ApiError
                      ? price.error.message
                      : st('supply.saveFailed')}
                  </p>
                ) : null}
              </div>
            </form>
          </Section>
        )}

        <PermissionGate allowed={mayRead}>
          <section aria-label={st('supply.entries')}>
            {entries.isPending ? (
              <LoadingRows />
            ) : entryRows.length === 0 ? (
              <EmptyState icon={PackageOpen} title={st('supply.empty')} />
            ) : (
              <TableFrame label={st('supply.entries')}>
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <caption className="sr-only">{st('supply.entries')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        {st('supply.colDate')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('supply.supplier')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('supply.invoice')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('supply.colStatus')}
                      </th>
                      <th scope="col" className={TH}>
                        <span className="sr-only">{st('supply.receive')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entryRows.map((row) => (
                      <tr key={row.id} className={TR}>
                        <td className={`${TD} text-muted-foreground tabular-nums`}>
                          {row.businessDate ?? '—'}
                        </td>
                        <td className={`${TD} font-medium`}>{row.supplierName}</td>
                        <td className={`${TD} tabular-nums`}>{row.invoiceNumber ?? '—'}</td>
                        <td className={TD}>
                          <StatusBadge tone={STATUS_TONE[row.status]}>
                            {st(`supply.status.${row.status}` as SupplyMessageKey)}
                          </StatusBadge>
                        </td>
                        <td className={`${TD} text-right`}>
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
              </TableFrame>
            )}
          </section>
        </PermissionGate>
        <StickerDialog
          open={stickers !== null}
          onOpenChange={(next) => {
            if (!next) setStickers(null);
          }}
          items={stickers ?? []}
        />
      </div>
    </PermissionGate>
  );
}
