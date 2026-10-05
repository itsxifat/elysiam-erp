/**
 * What the website may sell of a SKU (M33, D-503).
 *
 * The website sells from the stock locations the brand names on Website → Settings (by
 * default its main warehouse), never from a showroom shelf it did not name. A unit is
 * available when it is on hand there and nobody holds it: `on_hand − reserved`, summed over
 * those locations.
 *
 * `inventory.stock_levels` already refuses `reserved > on_hand` with a CHECK, so each term is
 * never negative in a healthy database. The clamp here is per location rather than on the
 * sum on purpose: a corrupted row that held more than it had must not hide the units another
 * web location really has, and it must never make the website show a negative quantity.
 */

/** One `inventory.stock_levels` row, as the inventory module's API hands it over. */
export interface StockLevel {
  readonly skuId: string;
  readonly locationId: string;
  readonly onHand: number;
  readonly reserved: number;
}

function units(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * Units available to the website for each SKU, over the web locations only.
 *
 * Every SKU that appears in `levels` is in the result (at 0 when it has nothing at a web
 * location), so a caller can tell "sold out" from "not asked about". A location listed
 * twice counts once.
 */
export function availableForWeb(
  levels: readonly StockLevel[],
  webLocationIds: readonly string[],
): Map<string, number> {
  const web = new Set(webLocationIds);
  const available = new Map<string, number>();
  for (const level of levels) {
    const before = available.get(level.skuId) ?? 0;
    if (!web.has(level.locationId)) {
      available.set(level.skuId, before);
      continue;
    }
    const free = Math.max(0, units(level.onHand) - units(level.reserved));
    available.set(level.skuId, before + free);
  }
  return available;
}

/** One SKU's available units, or 0. */
export function availableQtyFor(
  skuId: string,
  levels: readonly StockLevel[],
  webLocationIds: readonly string[],
): number {
  return (
    availableForWeb(
      levels.filter((level) => level.skuId === skuId),
      webLocationIds,
    ).get(skuId) ?? 0
  );
}
