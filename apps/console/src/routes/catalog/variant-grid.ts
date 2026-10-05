/**
 * The pure parts of the new-product form and the product page (plan `catalog-stock-ux`).
 *
 * No imports, so the unit test can load this without the API client, which reads the
 * Vite environment at import time.
 */

export interface AxisChoice {
  readonly attributeId: string;
  readonly values: readonly { readonly id: string; readonly label: string }[];
}

export interface VariantRow {
  /** The chosen value ids joined, sorted: stable across re-renders and axis order. */
  readonly key: string;
  readonly valueIds: readonly string[];
  /** `M / Red`, in the order the axes were chosen. */
  readonly label: string;
}

/**
 * Every combination of the chosen values, in the order the server will build them
 * (first axis outermost), so the grid reads like the SKU list that comes back.
 * Axes with nothing chosen are left out; none at all is one plain variant.
 */
export function variantRows(axes: readonly AxisChoice[]): VariantRow[] {
  const used = axes.filter((axis) => axis.values.length > 0);
  let rows: { ids: string[]; labels: string[] }[] = [{ ids: [], labels: [] }];
  for (const axis of used) {
    const next: { ids: string[]; labels: string[] }[] = [];
    for (const row of rows) {
      for (const value of axis.values) {
        next.push({ ids: [...row.ids, value.id], labels: [...row.labels, value.label] });
      }
    }
    rows = next;
  }
  return rows.map((row) => ({
    key: [...row.ids].sort().join('|'),
    valueIds: row.ids,
    label: row.labels.join(' / '),
  }));
}

/**
 * A code from a name, for the setup screen's "code" fields: upper-case letters and
 * digits only, cut to `max`. The person can still change it before saving; this only
 * spares them inventing one. A name with no Latin letters or digits (`লাল`) gives an
 * empty string, and the field then asks for a code.
 */
export function codeFrom(text: string, max: number): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, max);
}

/** A whole, positive quantity from a text field, or null (blank, zero, a fraction). */
export function parseQty(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 && value <= 1_000_000 ? value : null;
}

/** Sum of a column of integer stock numbers. */
export function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/** A CSV the browser can save, from the template text. */
export function csvDataUrl(text: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(text)}`;
}

/**
 * The new-products template (D-425). The same text as `PRODUCT_IMPORT_TEMPLATE` in
 * @elysium/domain, which the console does not depend on. The domain's test proves its
 * copy imports cleanly; the console's test pins this one's columns to the importer's.
 */
export const PRODUCT_TEMPLATE =
  'name,category,price_taka,sizes,colours,status,description\n' +
  'Linen Panjabi,PNJ,2450,M|L|XL,White|Cream,active,Soft linen for Eid\n';

/**
 * The idempotency key of one receipt a person is trying to save (D-432).
 *
 * The same key is sent on every attempt, through edits and through closing and
 * reopening the dialog, until the server has answered for it: a success, or a 409
 * `IDEMPOTENCY_CONFLICT`. Keeping it is always safe, because the supply routes replay a
 * known key only for the same supplier, location and lines, refuse it for anything else,
 * and insert normally when nothing was saved under it. Renewing it on an edit was not:
 * a first save whose response was lost, then an edit, posted a second receipt (ledger
 * re-audit). The person starts a new receipt only by succeeding or by being told an
 * earlier one already went through.
 */
export interface RequestKey {
  readonly current: () => string;
  readonly settle: () => void;
}

export function requestKey(make: () => string = () => crypto.randomUUID()): RequestKey {
  let value = make();
  return {
    current: () => value,
    settle: () => {
      value = make();
    },
  };
}

/** The server's answer to a known key with different goods (D-432). */
export function isReplayConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'IDEMPOTENCY_CONFLICT'
  );
}

/** A positive cost in taka, as poisha, or null: zero or blank is not a cost here. */
export function positiveCost(poisha: string | null): string | null {
  return poisha === null || /^0+$/.test(poisha) ? null : poisha;
}

/**
 * The variant a scanned code names, among one product's variants (M38a, D-605): its barcode
 * exactly, or its SKU code in any case.
 */
export function variantForCode<
  V extends { readonly skuCode: string; readonly barcode: string | null },
>(variants: readonly V[], code: string): V | undefined {
  const trimmed = code.trim();
  return (
    variants.find((variant) => variant.barcode !== null && variant.barcode === trimmed) ??
    variants.find((variant) => variant.skuCode === trimmed.toUpperCase())
  );
}

/** One more piece in a quantity box: blank or unreadable counts as none so far. */
export function addScannedPiece(
  quantities: Readonly<Record<string, string>>,
  skuId: string,
): Record<string, string> {
  const current = parseQty(quantities[skuId] ?? '') ?? 0;
  return { ...quantities, [skuId]: String(current + 1) };
}

// --- M39b: prices per variant (D-635 to D-639) ------------------------------------------

/**
 * A positive selling price in poisha, or null: blank, zero, a minus sign or text is not a
 * price (the server refuses all of them; the form says so first, D-635).
 */
export function positivePrice(poisha: string | null): string | null {
  return poisha === null || !/^[1-9]\d*$/.test(poisha) ? null : poisha;
}

/** What one grid cell holds: the text typed, and the price it reads as (null for none). */
export interface PriceText {
  readonly text: string;
  readonly poisha: string | null;
  /** Something was typed that is not a positive price. */
  readonly invalid: boolean;
}

/**
 * The price each row of the new-product grid will be created at (D-635): the row's own, else
 * its size's quick fill, else its colour's, else the main price. Precedence as
 * `@elysium/domain/pricing`'s `gridPrice`, here over the rows' value ids.
 */
export function resolveRowPrices(
  rows: readonly VariantRow[],
  input: {
    readonly own: Readonly<Record<string, string | null>>;
    readonly bySize: Readonly<Record<string, string | null>>;
    readonly byColour: Readonly<Record<string, string | null>>;
    readonly main: string | null;
  },
): Map<string, string | null> {
  const resolved = new Map<string, string | null>();
  for (const row of rows) {
    const size = row.valueIds.map((id) => input.bySize[id] ?? null).find((p) => p !== null);
    const colour = row.valueIds.map((id) => input.byColour[id] ?? null).find((p) => p !== null);
    resolved.set(row.key, input.own[row.key] ?? size ?? colour ?? input.main);
  }
  return resolved;
}

/**
 * Copy one row's typed cells to every row below it (D-635): the person types XL's price,
 * cost and pieces once and copies them down instead of typing them again.
 */
export function copyDown(
  values: Readonly<Record<string, string>>,
  rows: readonly VariantRow[],
  fromKey: string,
): Record<string, string> {
  const index = rows.findIndex((row) => row.key === fromKey);
  if (index === -1) return { ...values };
  const source = values[fromKey] ?? '';
  const next = { ...values };
  for (const row of rows.slice(index + 1)) next[row.key] = source;
  return next;
}

/** Set one value on every chosen row (the grid's "set for the selected variants"). */
export function fillRows(
  values: Readonly<Record<string, string>>,
  keys: Iterable<string>,
  text: string,
): Record<string, string> {
  const next = { ...values };
  for (const key of keys) next[key] = text;
  return next;
}

/** A whole number of grams from 1 to 100 kg, or null; blank is `undefined` (no weight). */
export function parseGrams(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const grams = Number(trimmed);
  return grams >= 1 && grams <= 100_000 ? grams : null;
}

/** One existing variant as the sizes-and-colours section reads it. */
export interface ExistingVariant {
  readonly id: string;
  readonly valueIds: readonly string[];
  readonly status: 'active' | 'archived';
  readonly pricePoisha: string;
}

/** What saving the sizes-and-colours section will do (D-639). */
export interface ExtendPlan {
  /** New combinations, by sorted value-id key, each with its value ids. */
  readonly add: readonly { readonly key: string; readonly valueIds: readonly string[] }[];
  /** Active variants carrying a value that was unticked: stop selling them. */
  readonly archive: readonly string[];
  /** Archived variants whose values are all ticked again: sell them again. */
  readonly restore: readonly string[];
  /**
   * Variants that do not have a value on an axis being added (a size-only product gaining
   * colours): they will not match the new ones; offered for archiving.
   */
  readonly orphans: readonly string[];
}

/**
 * Plan the sizes-and-colours change from the ticked values per axis (D-639). Mirrors the
 * server's `matrixPlan` by value-id sets, so the dialog can show and price the new rows before
 * anything is saved. Axes with nothing ticked are left out, as on creation.
 */
export function planExtend(
  existing: readonly ExistingVariant[],
  chosen: readonly { readonly attributeId: string; readonly valueIds: readonly string[] }[],
  valueAxis: ReadonlyMap<string, string>,
): ExtendPlan {
  const used = chosen.filter((axis) => axis.valueIds.length > 0);
  let combos: string[][] = [[]];
  for (const axis of used) {
    combos = combos.flatMap((combo) => axis.valueIds.map((id) => [...combo, id]));
  }
  const keyOf = (ids: readonly string[]) => [...ids].sort().join('|');
  const existingKeys = new Set(existing.map((variant) => keyOf(variant.valueIds)));
  const add =
    used.length === 0
      ? []
      : combos
          .filter((combo) => !existingKeys.has(keyOf(combo)))
          .map((combo) => ({ key: keyOf(combo), valueIds: combo }));

  const ticked = new Set(used.flatMap((axis) => axis.valueIds));
  const chosenAxes = new Set(used.map((axis) => axis.attributeId));
  const axesOf = (variant: ExistingVariant) =>
    new Set(variant.valueIds.map((id) => valueAxis.get(id) ?? ''));
  const archive: string[] = [];
  const restore: string[] = [];
  const orphans: string[] = [];
  for (const variant of existing) {
    const allTicked = variant.valueIds.every((id) => ticked.has(id));
    const own = axesOf(variant);
    const missingAxis = [...chosenAxes].some((axis) => !own.has(axis));
    if (variant.status === 'active') {
      if (!allTicked) archive.push(variant.id);
      else if (missingAxis) orphans.push(variant.id);
    } else if (allTicked && !missingAxis && variant.valueIds.length > 0) {
      restore.push(variant.id);
    }
  }
  return { add, archive, restore, orphans };
}
