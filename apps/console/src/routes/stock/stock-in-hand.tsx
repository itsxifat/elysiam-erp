import {
  Button,
  ConfirmDialog,
  DateTime,
  Dialog,
  EmptyState,
  Money,
  PermissionGate,
  Select,
  StatusBadge,
  cn,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Lock, Plus, Printer, Trash2, Undo2, Unlock } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import { getProduct, listProducts, lookupCode } from '../catalog/api.js';
import { ScanField } from '../catalog/scan-field.js';
import { StickerDialog, type StickerItem } from '../catalog/stickers.js';
import {
  addScannedPiece,
  isReplayConflict,
  parseQty,
  positiveCost,
  requestKey,
  variantForCode,
} from '../catalog/variant-grid.js';
import {
  closeOpeningStock,
  deleteStockInHandDraft,
  draftStockInHand,
  getStockInHand,
  listLocations,
  listStockInHand,
  openingStockWindow,
  postStockInHand,
  postStockInHandDraft,
  requestOpeningStockReopen,
  requestStockInHandReversal,
  type StockInHandEntry,
  type StockInHandStatus,
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

/**
 * Stock in hand at the start (M38a, D-602): the stock the brand already holds when it starts
 * on the ERP, counted in shelf by shelf at what each piece cost.
 *
 * - **The window.** Open on a new brand; an org admin closes it once everything is counted
 *   in, and from then on stock arrives only from suppliers, transfers, returns and approved
 *   adjustments. Reopening is a request a second admin approves.
 * - **An entry** is a location and its pieces: scan each sticker (or add a product and type
 *   its sizes' quantities), give the cost per piece, and post. Each posted entry is one
 *   journal, Dr Inventory / Cr Opening balance equity, and its pieces show in each
 *   product's stock history as opening stock.
 * - **Warehouse** counts without costs and saves a draft; someone who may see costs prices
 *   it and posts it (D-005's split, as for supply), as it stood when they opened it.
 * - **A mistake** (a shelf counted in twice) is reversed while the window is open: someone
 *   who may see costs asks, a second admin approves, and the pieces and the books come back
 *   out exactly.
 *
 * After saving, the entry's stickers are one click away: one per piece.
 */

interface Line {
  readonly skuId: string;
  readonly skuCode: string;
  readonly barcode: string | null;
  readonly label: string;
  readonly qty: string;
  readonly cost: string;
}

export function StockInHandPage() {
  const ability = useAbility();
  const t = useT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Stock');
  const mayEnter = ability.can('create', 'Supply');
  const mayPrice = ability.can('read', 'Cost');
  const mayClose = ability.can('approve', 'StockAdjustment');

  const [stickers, setStickers] = useState<readonly StickerItem[] | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [pricing, setPricing] = useState<string | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const openingWindow = useQuery({
    queryKey: ['stock', 'opening-window'],
    queryFn: openingStockWindow,
    enabled: mayRead,
  });
  const entries = useQuery({
    queryKey: ['stock', 'stock-in-hand'],
    queryFn: listStockInHand,
    enabled: mayEnter,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };

  const open = openingWindow.data?.open === true;

  const close = useMutation({
    mutationFn: (note: string) => closeOpeningStock(note.trim() === '' ? undefined : note.trim()),
    onSuccess: refresh,
  });

  const printEntry = async (id: string) => {
    const entry = await getStockInHand(id);
    setStickers(entryStickers(entry));
  };

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('st.inHand.deniedTitle'), detail: t('st.inHand.deniedDetail') }}
    >
      <div className="space-y-6">
        <StockHeader title={t('st.inHand.title')} description={t('st.inHand.help')} />

        <section
          aria-labelledby="window-heading"
          className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-card p-5"
        >
          <div className="space-y-1">
            <h2 id="window-heading" className="flex items-center gap-2 text-base font-semibold">
              {open ? (
                <Unlock aria-hidden="true" className="size-4" />
              ) : (
                <Lock aria-hidden="true" className="size-4" />
              )}
              {t('st.window.title')}
              {openingWindow.data === undefined ? null : (
                <span data-testid="window-status">
                  <StatusBadge tone={open ? 'success' : 'neutral'}>
                    {open ? t('st.window.open') : t('st.window.closed')}
                  </StatusBadge>
                </span>
              )}
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              {open ? t('st.window.openHelp') : t('st.window.closedHelp')}
            </p>
            {!open && openingWindow.data?.closedAt != null ? (
              <p className="text-xs text-muted-foreground">
                {`${t('st.window.closedOn')} `}
                <DateTime value={openingWindow.data.closedAt} />
              </p>
            ) : null}
            {openingWindow.data?.reopenPending === true ? (
              <p role="status" className="text-sm">
                {t('st.window.reopenPending')}
              </p>
            ) : null}
          </div>
          <PermissionGate allowed={mayClose}>
            {open ? (
              <Button variant="outline" data-testid="close-window" onClick={() => setClosing(true)}>
                <Lock aria-hidden="true" />
                {t('st.window.close')}
              </Button>
            ) : openingWindow.data?.reopenPending === true ? null : (
              <Button variant="outline" onClick={() => setReopening(true)}>
                <Unlock aria-hidden="true" />
                {t('st.window.askReopen')}
              </Button>
            )}
          </PermissionGate>
        </section>

        {open && mayEnter ? (
          <NewEntry
            mayPrice={mayPrice}
            onSaved={(items) => {
              refresh();
              setStickers(items);
            }}
          />
        ) : null}

        <PermissionGate allowed={mayEnter}>
          <section aria-labelledby="entries-heading" className="space-y-3">
            <h2 id="entries-heading" className="text-base font-semibold tracking-tight">
              {t('st.inHand.entries')}
            </h2>
            {notice === null ? null : (
              <p role="status" className="text-sm">
                {notice}
              </p>
            )}
            {(entries.data?.items ?? []).length === 0 ? (
              <EmptyState icon={Boxes} title={t('st.inHand.none')} />
            ) : (
              <TableFrame label={t('st.inHand.entries')}>
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <caption className="sr-only">{t('st.inHand.entries')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        {t('st.col.when')}
                      </th>
                      <th scope="col" className={TH}>
                        {t('st.col.location')}
                      </th>
                      <th scope="col" className={TH}>
                        {t('st.col.status')}
                      </th>
                      <th scope="col" className={TH_NUM}>
                        {t('st.col.pieces')}
                      </th>
                      {mayPrice ? (
                        <th scope="col" className={TH_NUM}>
                          {t('st.col.value')}
                        </th>
                      ) : null}
                      <th scope="col" className={TH}>
                        <span className="sr-only">{t('st.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(entries.data?.items ?? []).map((entry) => (
                      <tr key={entry.id} className={TR}>
                        <td className={`${TD} text-muted-foreground`}>
                          <DateTime value={entry.postedAt ?? entry.createdAt} />
                        </td>
                        <td className={TD}>
                          {entry.locationName}
                          {entry.memo === null ? null : (
                            <span className="ms-2 text-xs text-muted-foreground">{entry.memo}</span>
                          )}
                        </td>
                        <td className={TD}>
                          <StatusBadge tone={STATUS_TONE[entry.status]}>
                            {t(STATUS_LABEL[entry.status])}
                          </StatusBadge>
                        </td>
                        <td className={TD_NUM}>{entry.totalQty}</td>
                        {mayPrice ? (
                          <td className={TD_NUM}>
                            {entry.stockValuePoisha == null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <Money poisha={entry.stockValuePoisha} />
                            )}
                          </td>
                        ) : null}
                        <td className={`${TD} text-right`}>
                          <span className="inline-flex items-center gap-1">
                            {entry.status === 'draft' && mayPrice && open ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPricing(entry.id)}
                              >
                                {t('st.inHand.priceAndPost')}
                              </Button>
                            ) : null}
                            {entry.status === 'reversed' ? null : (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t('st.inHand.printEntry')}
                                onClick={() => void printEntry(entry.id)}
                              >
                                <Printer aria-hidden="true" />
                              </Button>
                            )}
                            {entry.status === 'posted' && mayPrice && open ? (
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t('st.inHand.reverse')}
                                onClick={() => {
                                  setNotice(null);
                                  setReversing(entry.id);
                                }}
                              >
                                <Undo2 aria-hidden="true" />
                              </Button>
                            ) : null}
                            {entry.status === 'draft' ? (
                              <DeleteDraft id={entry.id} onDone={refresh} />
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
          </section>
        </PermissionGate>

        <ConfirmDialog
          open={closing}
          onOpenChange={setClosing}
          title={t('st.window.closeTitle')}
          description={t('st.window.closeHelp')}
          confirmLabel={t('st.window.close')}
          cancelLabel={t('st.cancel')}
          closeLabel={t('st.close')}
          destructive
          onConfirm={async () => {
            await close.mutateAsync('');
          }}
        />
        <ReopenDialog open={reopening} onOpenChange={setReopening} onDone={refresh} />
        {reversing === null ? null : (
          <ReverseDialog
            id={reversing}
            onClose={() => setReversing(null)}
            onSent={() => {
              setReversing(null);
              setNotice(t('st.inHand.reverseSent'));
              refresh();
            }}
          />
        )}
        {pricing === null ? null : (
          <PriceDraftDialog
            id={pricing}
            onClose={() => setPricing(null)}
            onPosted={(items) => {
              setPricing(null);
              refresh();
              setStickers(items);
            }}
          />
        )}
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

const STATUS_TONE: Readonly<Record<StockInHandStatus, 'success' | 'warning' | 'neutral'>> = {
  draft: 'warning',
  posted: 'success',
  reversed: 'neutral',
};

const STATUS_LABEL = {
  draft: 'st.inHand.draft',
  posted: 'st.inHand.posted',
  reversed: 'st.inHand.reversed',
} as const satisfies Readonly<Record<StockInHandStatus, string>>;

function entryStickers(entry: StockInHandEntry): StickerItem[] {
  return entry.lines.map((line) => ({
    skuId: line.skuId,
    label:
      line.variantLabel === '' ? line.productName : `${line.productName} · ${line.variantLabel}`,
    skuCode: line.skuCode,
    count: line.qty,
  }));
}

/** A new entry: a location, then its pieces by scanning or by product, then post. */
function NewEntry({
  mayPrice,
  onSaved,
}: {
  readonly mayPrice: boolean;
  readonly onSaved: (stickers: StickerItem[]) => void;
}) {
  const t = useT();
  const [locationId, setLocationId] = useState('');
  const [memo, setMemo] = useState('');
  const [costTaka, setCostTaka] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [key] = useState(() => requestKey());

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  });
  const receivable = (locations.data?.items ?? []).filter(
    (location) =>
      location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
  );
  const chosenLocation =
    locationId !== '' ? locationId : (receivable.find((l) => l.kind === 'warehouse')?.id ?? '');

  const products = useQuery({
    queryKey: ['catalog', 'products', 'pick', search],
    queryFn: () => listProducts({ q: search, limit: 8 }),
    enabled: search.trim().length >= 3,
  });

  const commonCost = positiveCost(takaToPoisha(costTaka));
  const costOf = (line: Line) =>
    line.cost.trim() === '' ? commonCost : positiveCost(takaToPoisha(line.cost));
  const counted = lines.flatMap((line) => {
    const qty = parseQty(line.qty);
    return qty === null ? [] : [{ line, qty }];
  });
  const qtyProblem = lines.some((line) => line.qty.trim() !== '' && parseQty(line.qty) === null);
  const costMissing = mayPrice && counted.some((entry) => costOf(entry.line) === null);
  const pieces = counted.reduce((sum, entry) => sum + entry.qty, 0);
  const value = mayPrice
    ? counted.reduce((sum, entry) => {
        const cost = costOf(entry.line);
        return cost === null ? sum : sum + BigInt(cost) * BigInt(entry.qty);
      }, 0n)
    : 0n;
  const ready = chosenLocation !== '' && counted.length > 0 && !qtyProblem && !costMissing;

  const addOne = (found: Omit<Line, 'qty' | 'cost'>) =>
    setLines((current) => {
      const existing = current.find((line) => line.skuId === found.skuId);
      if (existing === undefined) return [...current, { ...found, qty: '1', cost: '' }];
      const bumped = addScannedPiece({ [found.skuId]: existing.qty }, found.skuId);
      return current.map((line) =>
        line.skuId === found.skuId ? { ...line, qty: bumped[found.skuId] ?? line.qty } : line,
      );
    });

  const scan = async (code: string) => {
    const known = variantForCode(lines, code);
    if (known !== undefined) {
      addOne(known);
      setMessage({ text: `${t('st.scan.added')} ${known.label}`, error: false });
      return;
    }
    try {
      const found = await lookupCode(code);
      const label =
        found.sku.variantLabel === ''
          ? found.product.name
          : `${found.product.name} · ${found.sku.variantLabel}`;
      addOne({ skuId: found.sku.id, skuCode: found.sku.code, barcode: found.sku.barcode, label });
      setMessage({ text: `${t('st.scan.added')} ${label}`, error: false });
    } catch (error) {
      setMessage({
        text:
          error instanceof ApiError && error.status === 404
            ? t('st.scan.notFound')
            : t('st.scan.failed'),
        error: true,
      });
    }
  };

  const addProduct = async (productId: string) => {
    const product = await getProduct(productId);
    setLines((current) => [
      ...current,
      ...product.skus
        .filter((sku) => sku.status === 'active')
        .filter((sku) => !current.some((line) => line.skuId === sku.id))
        .map((sku) => {
          const variant = sku.attributes.map((pair) => pair.valueLabel).join(' / ');
          return {
            skuId: sku.id,
            skuCode: sku.skuCode,
            barcode: sku.barcode,
            label: variant === '' ? product.name : `${product.name} · ${variant}`,
            qty: '',
            cost: '',
          };
        }),
    ]);
    setSearch('');
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload = counted.map((entry) => ({ skuId: entry.line.skuId, qty: entry.qty }));
      if (mayPrice) {
        await postStockInHand({
          entryId: key.current(),
          locationId: chosenLocation,
          ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
          lines: counted.map((entry) => ({
            skuId: entry.line.skuId,
            qty: entry.qty,
            unitCostPoisha: costOf(entry.line) ?? '0',
          })),
        });
      } else {
        await draftStockInHand({
          entryId: key.current(),
          locationId: chosenLocation,
          ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
          lines: payload,
        });
      }
      return counted.map((entry) => ({
        skuId: entry.line.skuId,
        label: entry.line.label,
        skuCode: entry.line.skuCode,
        count: entry.qty,
      }));
    },
    onError: (error) => {
      if (isReplayConflict(error)) key.settle();
    },
    onSuccess: (items) => {
      key.settle();
      setLines([]);
      setMemo('');
      setMessage(null);
      onSaved(items);
    },
  });

  return (
    <section
      aria-labelledby="new-entry-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 id="new-entry-heading" className="text-base font-semibold tracking-tight">
        {t('st.inHand.newEntry')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {mayPrice ? t('st.inHand.newHelp') : t('st.inHand.newHelpDraft')}
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('st.col.location')} id="in-hand-location">
          <Select
            id="in-hand-location"
            value={chosenLocation}
            onValueChange={setLocationId}
            options={receivable.map((location) => ({ value: location.id, label: location.name }))}
          />
        </Field>
        {mayPrice ? (
          <Field label={t('st.col.costPerPiece')} id="in-hand-cost" hint={t('st.inHand.costHint')}>
            <input
              id="in-hand-cost"
              inputMode="decimal"
              value={costTaka}
              onChange={(event) => setCostTaka(event.target.value)}
              className={cn(control, 'text-right tabular-nums')}
            />
          </Field>
        ) : null}
        <Field label={t('st.inHand.memo')} id="in-hand-memo">
          <input
            id="in-hand-memo"
            value={memo}
            maxLength={500}
            onChange={(event) => setMemo(event.target.value)}
            className={control}
          />
        </Field>
      </div>

      <ScanField
        message={message?.text ?? null}
        tone={message?.error === true ? 'error' : 'neutral'}
        onCode={(code) => void scan(code)}
      />

      <div className="space-y-1.5">
        <label htmlFor="in-hand-product" className="text-sm font-medium">
          {t('st.inHand.addProduct')}
        </label>
        <input
          id="in-hand-product"
          value={search}
          placeholder={t('st.inHand.addProductHint')}
          onChange={(event) => setSearch(event.target.value)}
          className={control}
        />
        {(products.data?.items ?? []).length > 0 && search.trim().length >= 3 ? (
          <ul className="divide-y divide-border rounded-md border border-border bg-background text-sm">
            {(products.data?.items ?? []).map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                  onClick={() => void addProduct(product.id)}
                >
                  <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
                  {product.name}
                  <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                    {`${String(product.skuCount)} ${t('st.inHand.variants')}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {lines.length === 0 ? null : (
        <TableFrame label={t('st.inHand.lines')}>
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">{t('st.inHand.lines')}</caption>
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  {t('st.col.item')}
                </th>
                <th scope="col" className={TH_NUM}>
                  {t('st.col.pieces')}
                </th>
                {mayPrice ? (
                  <th scope="col" className={TH_NUM}>
                    {t('st.col.costPerPiece')}
                  </th>
                ) : null}
                <th scope="col" className={TH}>
                  <span className="sr-only">{t('st.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.skuId} className={TR}>
                  <td className={TD}>
                    <span className="font-medium">{line.label}</span>
                    <span className="ms-2 text-xs text-muted-foreground tabular-nums">
                      {line.skuCode}
                    </span>
                  </td>
                  <td className={`${TD} text-right`}>
                    <label className="sr-only" htmlFor={`in-hand-qty-${line.skuId}`}>
                      {`${t('st.col.pieces')} ${line.label}`}
                    </label>
                    <input
                      id={`in-hand-qty-${line.skuId}`}
                      inputMode="numeric"
                      value={line.qty}
                      placeholder="0"
                      aria-invalid={line.qty.trim() !== '' && parseQty(line.qty) === null}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((entry) =>
                            entry.skuId === line.skuId
                              ? { ...entry, qty: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      className={cn(control, 'h-control-sm w-24 text-right tabular-nums')}
                    />
                  </td>
                  {mayPrice ? (
                    <td className={`${TD} text-right`}>
                      <label className="sr-only" htmlFor={`in-hand-cost-${line.skuId}`}>
                        {`${t('st.col.costPerPiece')} ${line.label}`}
                      </label>
                      <input
                        id={`in-hand-cost-${line.skuId}`}
                        inputMode="decimal"
                        value={line.cost}
                        placeholder={costTaka}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((entry) =>
                              entry.skuId === line.skuId
                                ? { ...entry, cost: event.target.value }
                                : entry,
                            ),
                          )
                        }
                        className={cn(control, 'h-control-sm w-28 text-right tabular-nums')}
                      />
                    </td>
                  ) : null}
                  <td className={`${TD} text-right`}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${t('st.inHand.removeLine')} ${line.label}`}
                      onClick={() =>
                        setLines((current) => current.filter((entry) => entry.skuId !== line.skuId))
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}

      {costMissing ? <p className="text-sm text-destructive">{t('st.new.costMissing')}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          data-testid="save-in-hand"
          disabled={!ready || save.isPending}
          onClick={() => save.mutate()}
        >
          {mayPrice ? t('st.inHand.post') : t('st.inHand.saveDraft')}
        </Button>
        <p className="text-sm text-muted-foreground tabular-nums">
          {`${String(pieces)} ${t('st.inHand.piecesTotal')}`}
          {mayPrice && !costMissing && pieces > 0 ? (
            <>
              {' · '}
              <Money poisha={value.toString()} />
            </>
          ) : null}
        </p>
      </div>
      {save.error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof ApiError ? save.error.message : t('st.saveFailed')}
        </p>
      )}
    </section>
  );
}

function DeleteDraft({ id, onDone }: { readonly id: string; readonly onDone: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={t('st.inHand.deleteDraft')}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('st.inHand.deleteDraft')}
        description={t('st.inHand.deleteDraftHelp')}
        confirmLabel={t('st.inHand.deleteDraft')}
        cancelLabel={t('st.cancel')}
        closeLabel={t('st.close')}
        destructive
        onConfirm={async () => {
          await deleteStockInHandDraft(id);
          onDone();
        }}
      />
    </>
  );
}

function ReopenDialog({
  open,
  onOpenChange,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const ask = useMutation({
    mutationFn: () => requestOpeningStockReopen(reason.trim()),
    onSuccess: () => {
      setReason('');
      onDone();
      onOpenChange(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('st.window.reopenTitle')}
      description={t('st.window.reopenHelp')}
      closeLabel={t('st.close')}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('st.cancel')}
          </Button>
          <Button disabled={reason.trim().length < 3 || ask.isPending} onClick={() => ask.mutate()}>
            {t('st.window.askReopen')}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <label htmlFor="reopen-reason" className="text-sm font-medium">
          {t('st.window.reason')}
        </label>
        <textarea
          id="reopen-reason"
          value={reason}
          maxLength={500}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
          className={cn(control, 'h-auto py-2')}
        />
        {ask.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {ask.error instanceof ApiError ? ask.error.message : t('st.saveFailed')}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Ask to reverse a posted entry: a reason, for the second admin who decides it. */
function ReverseDialog({
  id,
  onClose,
  onSent,
}: {
  readonly id: string;
  readonly onClose: () => void;
  readonly onSent: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const ask = useMutation({
    mutationFn: () => requestStockInHandReversal(id, reason.trim()),
    onSuccess: onSent,
  });
  const failure =
    ask.error === null
      ? null
      : ask.error instanceof ApiError && ask.error.code === 'STOCK_IN_HAND_REVERSAL_BLOCKED'
        ? t('st.inHand.reverseBlocked')
        : ask.error instanceof ApiError
          ? ask.error.message
          : t('st.saveFailed');
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('st.inHand.reverseTitle')}
      description={t('st.inHand.reverseHelp')}
      closeLabel={t('st.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('st.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 3 || ask.isPending}
            onClick={() => ask.mutate()}
          >
            {t('st.inHand.reverseAsk')}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <label htmlFor="reverse-reason" className="text-sm font-medium">
          {t('st.inHand.reverseReason')}
        </label>
        <textarea
          id="reverse-reason"
          value={reason}
          maxLength={500}
          rows={3}
          onChange={(event) => setReason(event.target.value)}
          className={cn(control, 'h-auto py-2')}
        />
        {failure === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Price a warehouse draft and post it (read:cost), exactly as it was read. */
function PriceDraftDialog({
  id,
  onClose,
  onPosted,
}: {
  readonly id: string;
  readonly onClose: () => void;
  readonly onPosted: (stickers: StickerItem[]) => void;
}) {
  const t = useT();
  const [costs, setCosts] = useState<Record<string, string>>({});
  const entry = useQuery({
    queryKey: ['stock', 'stock-in-hand', id],
    queryFn: () => getStockInHand(id),
  });
  const lines = entry.data?.lines ?? [];
  const priced = lines.map((line) => ({
    skuId: line.skuId,
    unitCostPoisha: positiveCost(takaToPoisha(costs[line.skuId] ?? '')),
  }));
  const ready = lines.length > 0 && priced.every((line) => line.unitCostPoisha !== null);
  const post = useMutation({
    // The location and the pieces as this dialog shows them: a draft changed since is
    // refused, and the dialog reloads it so the person sees what they would post.
    mutationFn: () =>
      postStockInHandDraft(id, {
        locationId: entry.data?.locationId ?? '',
        lines: lines.map((line, index) => ({
          skuId: line.skuId,
          qty: line.qty,
          unitCostPoisha: priced[index]?.unitCostPoisha ?? '0',
        })),
      }),
    onSuccess: () => {
      if (entry.data !== undefined) onPosted(entryStickers(entry.data));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STOCK_IN_HAND_CHANGED') {
        void entry.refetch();
      }
    },
  });
  const failure =
    post.error === null
      ? null
      : post.error instanceof ApiError && post.error.code === 'STOCK_IN_HAND_CHANGED'
        ? t('st.inHand.changed')
        : post.error instanceof ApiError
          ? post.error.message
          : t('st.saveFailed');
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('st.inHand.priceTitle')}
      description={t('st.inHand.priceHelp')}
      closeLabel={t('st.close')}
      className="w-[min(40rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('st.cancel')}
          </Button>
          <Button disabled={!ready || post.isPending} onClick={() => post.mutate()}>
            {t('st.inHand.post')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {lines.map((line) => (
          <div key={line.skuId} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {line.variantLabel === ''
                ? line.productName
                : `${line.productName} · ${line.variantLabel}`}
              <span className="ms-2 text-muted-foreground tabular-nums">{`× ${String(line.qty)}`}</span>
            </span>
            <label className="sr-only" htmlFor={`price-draft-${line.skuId}`}>
              {`${t('st.col.costPerPiece')} ${line.skuCode}`}
            </label>
            <input
              id={`price-draft-${line.skuId}`}
              inputMode="decimal"
              value={costs[line.skuId] ?? ''}
              onChange={(event) =>
                setCosts((current) => ({ ...current, [line.skuId]: event.target.value }))
              }
              className={cn(control, 'h-control-sm w-28 text-right tabular-nums')}
            />
          </div>
        ))}
        {failure === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
