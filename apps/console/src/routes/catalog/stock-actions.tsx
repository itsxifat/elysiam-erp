import {
  Button,
  Dialog,
  Money,
  Select,
  cn,
  controlClassName,
  poishaToTaka,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import '../../i18n/catalog-pricing.js';
import {
  dispatchTransfer,
  draftStockInHand,
  listLocations,
  openingStockWindow,
  postStockInHand,
  requestAdjustment,
  setReorderLevel,
  type StockRow,
} from '../stock/api.js';
import { createDraft, createEntry, listSupplierOptions } from '../supply/api.js';
import { skuCosts, type PrefillSource } from './pricing-api.js';
import { ScanField } from './scan-field.js';
import {
  addScannedPiece,
  isReplayConflict,
  parseQty,
  positiveCost,
  requestKey,
  variantForCode,
} from './variant-grid.js';

/**
 * The product page's three stock actions (D-420): receive, adjust and transfer, each a
 * dialog with one quantity box per variant of this product.
 *
 * None of them changes stock directly, because nothing in the console can (invariant 3):
 *
 * - **Receive** posts one supply entry (`POST /v1/supply/entries`) with the supplier and
 *   the cost per piece, which is where purchase cost enters the books (invariant 5) and
 *   the journal is posted. A person without `read Cost` saves a quantity-only draft that
 *   accounts prices later (D-005), and the dialog says so.
 * - **Adjust** raises one adjustment request for approval; the stock moves when someone
 *   else approves it.
 * - **Transfer** dispatches one transfer; the stock arrives when the other end receives it.
 *
 * Cost is typed in taka and converted by `takaToPoisha`, which is integer arithmetic.
 *
 * M39b (D-637): Receive takes a cost **per variant** (an XL costs more than an M), prefilled
 * for a cost role from each variant's standard buying price for the chosen supplier, else its
 * standard for any supplier, else the last price it was bought at; the common cost fills any
 * variant still blank. Each line posts at its own cost, so each variant's average moves by
 * its own figure. A scanned sticker of an archived variant is refused here, as the grid does
 * not show one.
 */

export interface VariantInfo {
  readonly id: string;
  readonly skuCode: string;
  /** What a scanner reads off the sticker (M38a, D-603). */
  readonly barcode: string | null;
  readonly label: string;
  readonly status: 'active' | 'archived';
}

/**
 * A scan field over a dialog's quantity boxes (M38a, D-605): each scan of one of this
 * product's stickers adds one piece to its variant's box; a sticker of another product says
 * so and adds nothing.
 */
function ScanIntoQuantities({
  variants,
  setQuantities,
  refuseArchived = false,
}: {
  readonly variants: readonly VariantInfo[];
  readonly setQuantities: (
    update: (current: Record<string, string>) => Record<string, string>,
  ) => void;
  /** A receipt takes no archived variant (M39b): its row is not on the screen. */
  readonly refuseArchived?: boolean;
}) {
  const t = useT();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  return (
    <ScanField
      message={message?.text ?? null}
      tone={message?.error === true ? 'error' : 'neutral'}
      onCode={(code) => {
        const variant = variantForCode(variants, code);
        if (variant === undefined) {
          setMessage({ text: t('st.scan.notThisProduct'), error: true });
          return;
        }
        if (refuseArchived && variant.status === 'archived') {
          setMessage({ text: t('cp.receive.archivedScan'), error: true });
          return;
        }
        setQuantities((current) => addScannedPiece(current, variant.id));
        setMessage({
          text: `${t('st.scan.added')} ${variant.label === '' ? variant.skuCode : variant.label}`,
          error: false,
        });
      }}
    />
  );
}

const control = cn(controlClassName, 'w-full');
/** A quantity box in a table: the kit's control, narrow and right-aligned. */
const qtyControl = cn(
  controlClassName,
  'h-control-sm w-24 text-right tabular-nums aria-[invalid=true]:border-destructive',
);
const wide = 'w-[min(44rem,calc(100vw-2rem))]';

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** One quantity box per variant; `limit` caps it (what is available to send). */
/** A cost per piece per variant (M39b, D-637): its boxes, and where each prefill came from. */
interface CostColumn {
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (skuId: string, value: string) => void;
  readonly placeholder: string;
  readonly sources: ReadonlyMap<string, PrefillSource>;
  /** Variants with pieces but no cost yet. */
  readonly missing: ReadonlySet<string>;
}

function QtyTable({
  variants,
  quantities,
  onChange,
  limit,
  idPrefix,
  costs,
}: {
  readonly variants: readonly VariantInfo[];
  readonly quantities: Readonly<Record<string, string>>;
  readonly onChange: (skuId: string, value: string) => void;
  readonly limit?: ((skuId: string) => number) | undefined;
  readonly idPrefix: string;
  readonly costs?: CostColumn | undefined;
}) {
  const t = useT();
  const sourceLabel = {
    'supplier-standard': t('cp.receive.source.supplierStandard'),
    standard: t('cp.receive.source.standard'),
    last: t('cp.receive.source.last'),
  } as const;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('cs.qty.caption')}</caption>
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left">
            <th
              scope="col"
              className="h-10 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground"
            >
              {t('cs.col.variant')}
            </th>
            {limit === undefined ? null : (
              <th
                scope="col"
                className="h-10 px-3 text-right text-xs font-medium whitespace-nowrap text-muted-foreground"
              >
                {t('cs.col.available')}
              </th>
            )}
            <th
              scope="col"
              className="h-10 w-28 px-3 text-right text-xs font-medium whitespace-nowrap text-muted-foreground"
            >
              {t('cs.col.qty')}
            </th>
            {costs === undefined ? null : (
              <th
                scope="col"
                className="h-10 w-36 px-3 text-right text-xs font-medium whitespace-nowrap text-muted-foreground"
              >
                {t('st.col.costPerPiece')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {variants.map((variant) => {
            const max = limit?.(variant.id);
            const text = quantities[variant.id] ?? '';
            const qty = parseQty(text);
            const over = max !== undefined && qty !== null && qty > max;
            return (
              <tr key={variant.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{variant.label === '' ? '—' : variant.label}</span>
                  <span className="ms-2 text-xs text-muted-foreground tabular-nums">
                    {variant.skuCode}
                  </span>
                </td>
                {max === undefined ? null : (
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{max}</td>
                )}
                <td className="px-3 py-2 text-right">
                  <label className="sr-only" htmlFor={`${idPrefix}-${variant.id}`}>
                    {`${t('cs.col.qty')} ${variant.label || variant.skuCode}`}
                  </label>
                  <input
                    id={`${idPrefix}-${variant.id}`}
                    inputMode="numeric"
                    value={text}
                    placeholder="0"
                    aria-invalid={over || (text.trim() !== '' && qty === null)}
                    onChange={(event) => onChange(variant.id, event.target.value)}
                    className={qtyControl}
                  />
                </td>
                {costs === undefined ? null : (
                  <td className="px-3 py-2 text-right">
                    <label className="sr-only" htmlFor={`${idPrefix}-cost-${variant.id}`}>
                      {`${t('cp.col.cost')} ${variant.label || variant.skuCode}`}
                    </label>
                    <input
                      id={`${idPrefix}-cost-${variant.id}`}
                      inputMode="decimal"
                      value={costs.values[variant.id] ?? ''}
                      placeholder={costs.placeholder}
                      aria-invalid={
                        costs.missing.has(variant.id) ||
                        ((costs.values[variant.id] ?? '').trim() !== '' &&
                          positiveCost(takaToPoisha(costs.values[variant.id] ?? '')) === null)
                      }
                      onChange={(event) => costs.onChange(variant.id, event.target.value)}
                      className={cn(qtyControl, 'w-28')}
                    />
                    {costs.sources.has(variant.id) ? (
                      <span className="block text-xs text-muted-foreground">
                        {sourceLabel[costs.sources.get(variant.id) ?? 'last']}
                      </span>
                    ) : null}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function linesFrom(
  quantities: Readonly<Record<string, string>>,
): { skuId: string; qty: number }[] | null {
  const lines: { skuId: string; qty: number }[] = [];
  for (const [skuId, text] of Object.entries(quantities)) {
    if (text.trim() === '') continue;
    const qty = parseQty(text);
    if (qty === null) return null;
    lines.push({ skuId, qty });
  }
  return lines;
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
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// --- receive -------------------------------------------------------------------

export function ReceiveStockDialog({
  open,
  onOpenChange,
  variants,
  onDone,
  onReceived,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly variants: readonly VariantInfo[];
  readonly onDone: () => void;
  /** The pieces just received, for their stickers (D-604). */
  readonly onReceived?: (lines: readonly { skuId: string; qty: number }[]) => void;
}) {
  const t = useT();
  const ability = useAbility();
  const mayPrice = ability.can('read', 'Cost');
  // From a supplier, or stock the brand already holds while its window is open (D-602).
  const [source, setSource] = useState<'supplier' | 'in-hand'>('supplier');

  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [costTaka, setCostTaka] = useState('');
  const [invoice, setInvoice] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  // The costs the person typed (M39b, D-637); a variant not typed shows its prefill.
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [done, setDone] = useState<'entry' | 'draft' | null>(null);
  // One key per receipt being saved, kept across retries (ledger audit H1).
  const [key] = useState(() => requestKey());

  const openingWindow = useQuery({
    queryKey: ['stock', 'opening-window'],
    queryFn: openingStockWindow,
    enabled: open,
    staleTime: 60_000,
  });
  const inHand = source === 'in-hand' && openingWindow.data?.open === true;

  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', 'options'],
    queryFn: listSupplierOptions,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const receivable = (locations.data?.items ?? []).filter(
    (location) =>
      location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
  );
  const chosenLocation =
    locationId !== '' ? locationId : (receivable.find((l) => l.kind === 'warehouse')?.id ?? '');

  // The prefill (D-637, D-638): standard for this supplier, else any, else the last price.
  // Shown in a box until the person types over it; never copied into state, so a new supplier
  // re-prefills every box the person has not typed in.
  const activeIds = variants.filter((variant) => variant.status === 'active').map((v) => v.id);
  const prefill = useQuery({
    queryKey: ['supply', 'sku-costs', 'prefill', activeIds.join(','), inHand ? '' : supplierId],
    queryFn: () => skuCosts(activeIds, inHand ? undefined : supplierId),
    enabled: open && mayPrice && activeIds.length > 0,
  });
  const prefilled = new Map(
    (prefill.data?.items ?? []).flatMap((item) =>
      item.prefillUnitCostPoisha === null || item.prefillSource === null
        ? []
        : [
            [
              item.skuId,
              { text: poishaToTaka(item.prefillUnitCostPoisha), source: item.prefillSource },
            ] as const,
          ],
    ),
  );
  const shownCosts: Record<string, string> = Object.fromEntries(
    activeIds.map((id) => [id, costs[id] ?? prefilled.get(id)?.text ?? '']),
  );
  const sources = new Map<string, PrefillSource>(
    [...prefilled.entries()]
      .filter(([id]) => costs[id] === undefined)
      .map(([id, entry]) => [id, entry.source]),
  );

  const lines = linesFrom(quantities);
  // The common cost fills any variant left blank; a stray 0 is no cost, so a whole batch is
  // never received free by accident (free stock goes through Supply entries, D-096).
  const costPoisha = positiveCost(takaToPoisha(costTaka));
  const costOf = (skuId: string): string | null => {
    const own = (shownCosts[skuId] ?? '').trim();
    return own === '' ? costPoisha : positiveCost(takaToPoisha(own));
  };
  const units = (lines ?? []).reduce((sum, line) => sum + line.qty, 0);
  const missing = new Set(
    mayPrice ? (lines ?? []).filter((line) => costOf(line.skuId) === null).map((l) => l.skuId) : [],
  );
  const value = mayPrice
    ? (lines ?? []).reduce((sum, line) => {
        const cost = costOf(line.skuId);
        return cost === null ? sum : sum + BigInt(cost) * BigInt(line.qty);
      }, 0n)
    : 0n;
  const ready =
    (inHand || supplierId !== '') &&
    chosenLocation !== '' &&
    lines !== null &&
    lines.length > 0 &&
    (!mayPrice || missing.size === 0);

  const submit = useMutation({
    mutationFn: async () => {
      const chosen = lines ?? [];
      if (inHand) {
        if (mayPrice) {
          await postStockInHand({
            entryId: key.current(),
            locationId: chosenLocation,
            lines: chosen.map((line) => ({ ...line, unitCostPoisha: costOf(line.skuId) ?? '0' })),
          });
          return { kind: 'entry' as const, lines: chosen };
        }
        await draftStockInHand({
          entryId: key.current(),
          locationId: chosenLocation,
          lines: chosen,
        });
        return { kind: 'draft' as const, lines: chosen };
      }
      if (mayPrice) {
        // Each variant at its own cost (D-637).
        const lines = chosen.map((line) => ({
          ...line,
          unitCostPoisha: costOf(line.skuId) ?? '0',
        }));
        await createEntry({
          supplyId: key.current(),
          supplierId,
          locationId: chosenLocation,
          ...(invoice.trim() === '' ? {} : { invoiceNumber: invoice.trim() }),
          lines,
        });
        return { kind: 'entry' as const, lines: chosen };
      }
      await createDraft({
        draftId: key.current(),
        supplierId,
        locationId: chosenLocation,
        ...(invoice.trim() === '' ? {} : { invoiceNumber: invoice.trim() }),
        lines: chosen,
      });
      return { kind: 'draft' as const, lines: chosen };
    },
    // Told an earlier save went through with other goods: the next press is a new receipt.
    onError: (error) => {
      if (isReplayConflict(error)) key.settle();
    },
    onSuccess: (result) => {
      key.settle();
      setDone(result.kind);
      setQuantities({});
      setCosts({});
      onDone();
      onReceived?.(result.lines);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The key survives closing: an unanswered save may have gone through (D-432).
        if (!next) setDone(null);
        onOpenChange(next);
      }}
      title={t('cs.receive.title')}
      description={
        inHand
          ? t(mayPrice ? 'st.receive.inHandHelp' : 'st.receive.inHandHelpDraft')
          : t(mayPrice ? 'cs.receive.help' : 'cs.receive.helpDraft')
      }
      closeLabel={t('cs.close')}
      className={wide}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
            {t(mayPrice ? 'cs.receive.submit' : 'cs.receive.submitDraft')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {openingWindow.data?.open === true ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t('st.new.stockFrom')}</legend>
            <div className="flex flex-wrap gap-4">
              {(['supplier', 'in-hand'] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="receive-source"
                    value={value}
                    checked={source === value}
                    onChange={() => setSource(value)}
                    className="size-4 accent-primary"
                  />
                  {t(value === 'in-hand' ? 'st.new.inHand' : 'st.new.fromSupplier')}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {inHand ? null : (
            <Field label={t('cs.supplier')} id="receive-supplier">
              <Select
                id="receive-supplier"
                value={supplierId}
                onValueChange={setSupplierId}
                placeholder={t('cs.chooseSupplier')}
                options={(suppliers.data?.items ?? []).map((supplier) => ({
                  value: supplier.id,
                  label: `${supplier.name} (${supplier.code})`,
                }))}
              />
            </Field>
          )}
          <Field label={t('cs.location')} id="receive-location">
            <Select
              id="receive-location"
              value={chosenLocation}
              onValueChange={setLocationId}
              options={receivable.map((location) => ({ value: location.id, label: location.name }))}
            />
          </Field>
          {mayPrice ? (
            <Field
              label={t('cs.costPerPiece')}
              id="receive-cost"
              hint={t('cp.receive.sameForAllHint')}
            >
              <input
                id="receive-cost"
                inputMode="decimal"
                value={costTaka}
                onChange={(event) => setCostTaka(event.target.value)}
                className={cn(control, 'text-right tabular-nums')}
              />
            </Field>
          ) : null}
          {inHand ? null : (
            <Field label={t('cs.invoice')} id="receive-invoice">
              <input
                id="receive-invoice"
                value={invoice}
                maxLength={64}
                onChange={(event) => setInvoice(event.target.value)}
                className={control}
              />
            </Field>
          )}
        </div>
        {!inHand && (suppliers.data?.items ?? []).length === 0 && suppliers.isSuccess ? (
          <p className="text-sm text-muted-foreground">{t('cs.noSuppliers')}</p>
        ) : null}

        <ScanIntoQuantities variants={variants} setQuantities={setQuantities} refuseArchived />

        <QtyTable
          idPrefix="receive"
          variants={variants.filter((variant) => variant.status === 'active')}
          quantities={quantities}
          onChange={(skuId, value) => setQuantities((current) => ({ ...current, [skuId]: value }))}
          costs={
            mayPrice
              ? {
                  values: shownCosts,
                  placeholder: costTaka,
                  sources,
                  missing,
                  onChange: (skuId, text) => setCosts((current) => ({ ...current, [skuId]: text })),
                }
              : undefined
          }
        />

        {mayPrice && sources.size > 0 ? (
          <p className="text-xs text-muted-foreground">{t('cp.receive.prefilled')}</p>
        ) : null}
        {mayPrice && units > 0 && missing.size > 0 ? (
          <p className="text-sm text-destructive">{t('cp.receive.costMissing')}</p>
        ) : null}
        {mayPrice && units > 0 && missing.size === 0 ? (
          <p className="text-sm" data-testid="receive-total">
            {t('cs.receive.total')} <Money poisha={value.toString()} />
          </p>
        ) : null}
        {done !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(done === 'entry' ? 'cs.receive.done' : 'cs.receive.doneDraft')}
          </p>
        ) : null}
        {submit.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(submit.error, t('cs.saveFailed'))}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- adjust --------------------------------------------------------------------

const REASONS = ['damaged', 'lost', 'found', 'count'] as const;

export function AdjustStockDialog({
  open,
  onOpenChange,
  variants,
  stock,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly variants: readonly VariantInfo[];
  readonly stock: readonly StockRow[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const [locationId, setLocationId] = useState('');
  const [direction, setDirection] = useState<'loss' | 'gain'>('loss');
  const [reasonKind, setReasonKind] = useState<(typeof REASONS)[number]>('damaged');
  const [note, setNote] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [raised, setRaised] = useState<string | null>(null);

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const choosable = (locations.data?.items ?? []).filter(
    (location) => location.isActive && location.kind !== 'in_transit',
  );
  const chosenLocation =
    locationId !== '' ? locationId : (choosable.find((l) => l.kind === 'warehouse')?.id ?? '');

  const available = (skuId: string) =>
    stock.find((row) => row.skuId === skuId && row.locationId === chosenLocation)?.available ?? 0;

  const lines = linesFrom(quantities);
  const tooMany =
    direction === 'loss' && (lines ?? []).some((line) => line.qty > available(line.skuId));
  const reasonText = `${t(`cs.reason.${reasonKind}`)}${note.trim() === '' ? '' : ` — ${note.trim()}`}`;
  const ready = chosenLocation !== '' && lines !== null && lines.length > 0 && !tooMany;

  const submit = useMutation({
    mutationFn: () =>
      requestAdjustment({
        locationId: chosenLocation,
        direction,
        reason: reasonText,
        lines: lines ?? [],
      }),
    onSuccess: (row) => {
      setRaised(row.status);
      setQuantities({});
      setNote('');
      onDone();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRaised(null);
        onOpenChange(next);
      }}
      title={t('cs.adjust.title')}
      description={t('cs.adjust.help')}
      closeLabel={t('cs.close')}
      className={wide}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
            {t('cs.adjust.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cs.location')} id="adjust-location">
            <Select
              id="adjust-location"
              value={chosenLocation}
              onValueChange={setLocationId}
              options={choosable.map((location) => ({ value: location.id, label: location.name }))}
            />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium text-foreground">
              {t('cs.adjust.direction')}
            </legend>
            <div className="flex h-control items-center gap-4">
              {(['loss', 'gain'] as const).map((value) => (
                <label key={value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="adjust-direction"
                    checked={direction === value}
                    onChange={() => {
                      setDirection(value);
                      setReasonKind(value === 'loss' ? 'damaged' : 'found');
                    }}
                    className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {t(value === 'loss' ? 'cs.adjust.loss' : 'cs.adjust.gain')}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium text-foreground">
            {t('cs.adjust.reason')}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {REASONS.filter((reason) =>
              direction === 'loss' ? reason !== 'found' : reason === 'found' || reason === 'count',
            ).map((reason) => (
              <Button
                key={reason}
                type="button"
                size="sm"
                variant={reasonKind === reason ? 'primary' : 'outline'}
                aria-pressed={reasonKind === reason}
                onClick={() => setReasonKind(reason)}
              >
                {t(`cs.reason.${reason}`)}
              </Button>
            ))}
          </div>
          <label className="sr-only" htmlFor="adjust-note">
            {t('cs.adjust.note')}
          </label>
          <input
            id="adjust-note"
            value={note}
            maxLength={400}
            placeholder={t('cs.adjust.note')}
            onChange={(event) => setNote(event.target.value)}
            className={control}
          />
        </fieldset>

        <ScanIntoQuantities variants={variants} setQuantities={setQuantities} />

        <QtyTable
          idPrefix="adjust"
          variants={variants}
          quantities={quantities}
          limit={direction === 'loss' ? available : undefined}
          onChange={(skuId, value) => setQuantities((current) => ({ ...current, [skuId]: value }))}
        />

        {tooMany ? (
          <p role="alert" className="text-sm text-destructive">
            {t('cs.adjust.tooMany')}
          </p>
        ) : null}
        {raised !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(raised === 'posted' ? 'cs.adjust.posted' : 'cs.adjust.pending')}
          </p>
        ) : null}
        {submit.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(submit.error, t('cs.saveFailed'))}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- transfer ------------------------------------------------------------------

export function TransferStockDialog({
  open,
  onOpenChange,
  variants,
  stock,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly variants: readonly VariantInfo[];
  readonly stock: readonly StockRow[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [memo, setMemo] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const ends = (locations.data?.items ?? []).filter(
    (location) =>
      location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
  );
  const from = fromId !== '' ? fromId : (ends.find((l) => l.kind === 'warehouse')?.id ?? '');
  const to = toId !== '' ? toId : (ends.find((l) => l.id !== from)?.id ?? '');

  const available = (skuId: string) =>
    stock.find((row) => row.skuId === skuId && row.locationId === from)?.available ?? 0;
  const lines = linesFrom(quantities);
  const tooMany = (lines ?? []).some((line) => line.qty > available(line.skuId));
  const ready =
    from !== '' && to !== '' && from !== to && lines !== null && lines.length > 0 && !tooMany;

  const submit = useMutation({
    mutationFn: () =>
      dispatchTransfer({
        fromLocationId: from,
        toLocationId: to,
        ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
        lines: lines ?? [],
      }),
    onSuccess: () => {
      setSent(true);
      setQuantities({});
      onDone();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSent(false);
        onOpenChange(next);
      }}
      title={t('cs.transfer.title')}
      description={t('cs.transfer.help')}
      closeLabel={t('cs.close')}
      className={wide}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
            {t('cs.transfer.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {ends.length < 2 && locations.isSuccess ? (
          <p className="text-sm text-muted-foreground">{t('cs.transfer.needTwo')}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cs.transfer.from')} id="transfer-from">
            <Select
              id="transfer-from"
              value={from}
              onValueChange={setFromId}
              options={ends.map((location) => ({ value: location.id, label: location.name }))}
            />
          </Field>
          <Field label={t('cs.transfer.to')} id="transfer-to">
            <Select
              id="transfer-to"
              value={to}
              onValueChange={setToId}
              options={ends
                .filter((location) => location.id !== from)
                .map((location) => ({ value: location.id, label: location.name }))}
            />
          </Field>
        </div>
        <Field label={t('cs.transfer.memo')} id="transfer-memo">
          <input
            id="transfer-memo"
            value={memo}
            maxLength={400}
            onChange={(event) => setMemo(event.target.value)}
            className={control}
          />
        </Field>

        <ScanIntoQuantities variants={variants} setQuantities={setQuantities} />

        <QtyTable
          idPrefix="transfer"
          variants={variants}
          quantities={quantities}
          limit={available}
          onChange={(skuId, value) => setQuantities((current) => ({ ...current, [skuId]: value }))}
        />

        {tooMany ? (
          <p role="alert" className="text-sm text-destructive">
            {t('cs.transfer.tooMany')}
          </p>
        ) : null}
        {sent ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('cs.transfer.sent')}
          </p>
        ) : null}
        {submit.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(submit.error, t('cs.saveFailed'))}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- low-stock alerts -------------------------------------------------------------

/**
 * The level at which each variant counts as low at one location. The route existed
 * (`PUT /v1/inventory/reorder-levels`) but nothing could set it, so "Low" never showed.
 * One request per changed variant; 0 switches the alert off.
 */
export function ReorderDialog({
  open,
  onOpenChange,
  variants,
  stock,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly variants: readonly VariantInfo[];
  readonly stock: readonly StockRow[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const [locationId, setLocationId] = useState('');
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const choosable = (locations.data?.items ?? []).filter(
    (location) =>
      location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
  );
  const chosenLocation = locationId !== '' ? locationId : (choosable[0]?.id ?? '');
  const current = (skuId: string) =>
    stock.find((row) => row.skuId === skuId && row.locationId === chosenLocation)?.reorderLevel ??
    0;

  const changes = variants.flatMap((variant) => {
    const text = levels[variant.id];
    if (text === undefined) return [];
    const trimmed = text.trim();
    const value = trimmed === '' ? 0 : /^\d{1,7}$/.test(trimmed) ? Number(trimmed) : null;
    return value === null || value === current(variant.id)
      ? []
      : [{ skuId: variant.id, reorderLevel: value }];
  });
  const invalid = variants.some((variant) => {
    const text = (levels[variant.id] ?? '').trim();
    return text !== '' && !/^\d{1,7}$/.test(text);
  });

  const save = useMutation({
    mutationFn: async () => {
      for (const change of changes) {
        await setReorderLevel({ ...change, locationId: chosenLocation });
      }
    },
    onSuccess: () => {
      setSaved(true);
      setLevels({});
      onDone();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSaved(false);
        onOpenChange(next);
      }}
      title={t('cs.reorder.title')}
      description={t('cs.reorder.help')}
      closeLabel={t('cs.close')}
      className={wide}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button
            disabled={changes.length === 0 || invalid || chosenLocation === '' || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('cs.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('cs.location')} id="reorder-location">
          <Select
            id="reorder-location"
            value={chosenLocation}
            onValueChange={(value) => {
              setLocationId(value);
              setLevels({});
            }}
            options={choosable.map((location) => ({ value: location.id, label: location.name }))}
          />
        </Field>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('cs.reorder.title')}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th
                  scope="col"
                  className="h-10 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground"
                >
                  {t('cs.col.variant')}
                </th>
                <th
                  scope="col"
                  className="h-10 w-32 px-3 text-right text-xs font-medium whitespace-nowrap text-muted-foreground"
                >
                  {t('cs.reorder.col')}
                </th>
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => (
                <tr key={variant.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 font-medium">
                    {variant.label === '' ? variant.skuCode : variant.label}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <label className="sr-only" htmlFor={`reorder-${variant.id}`}>
                      {`${t('cs.reorder.col')} ${variant.label || variant.skuCode}`}
                    </label>
                    <input
                      id={`reorder-${variant.id}`}
                      inputMode="numeric"
                      value={levels[variant.id] ?? String(current(variant.id))}
                      onChange={(event) =>
                        setLevels((state) => ({ ...state, [variant.id]: event.target.value }))
                      }
                      className={qtyControl}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('cs.reorder.saved')}
          </p>
        ) : null}
        {save.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(save.error, t('cs.saveFailed'))}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
