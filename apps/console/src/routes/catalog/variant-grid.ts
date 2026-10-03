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
