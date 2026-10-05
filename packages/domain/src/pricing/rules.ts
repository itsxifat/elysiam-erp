import { BASIS_POINTS, divideRounded, MAX_POISHA, type Poisha } from '../money/index.js';

/**
 * Variant prices and buying prices (M39b, D-635 to D-640): the arithmetic the new-product
 * grid, the product page's bulk price editor, the receipt forms and the catalog service
 * share, so a preview and the server can never disagree about a figure.
 *
 * Every amount is integer poisha (invariant 1) and every rounding goes through
 * `divideRounded`, the money module's one rounding rule (half away from zero). Nothing
 * here reads or writes storage.
 *
 * Its own entry point (`@elysium/domain/pricing`) because the console runs the same
 * functions in the browser for the preview; it imports only the money module.
 */

/** A selling price or a regular price may not exceed the catalog's own bound (§7). */
export const PRICE_BOUND_POISHA = MAX_POISHA;

// --- bulk price rules (D-636) -------------------------------------------------------------

/**
 * One change to apply to many variants at once.
 *
 * - `set`: every chosen variant to exactly `amountPoisha`;
 * - `add`: `amountPoisha` added (negative subtracts);
 * - `percent`: `basisPoints` / 10,000 of the current amount added (negative lowers it),
 *   `1000` being +10 %, rounded to the poisha once.
 *
 * `roundToPoisha`, when above zero, then rounds the result to the nearest multiple of it
 * (`1000n` is to the nearest ৳10), half away from zero.
 */
export type PriceRule =
  | {
      readonly kind: 'set';
      readonly amountPoisha: bigint;
      readonly roundToPoisha?: bigint | undefined;
    }
  | {
      readonly kind: 'add';
      readonly amountPoisha: bigint;
      readonly roundToPoisha?: bigint | undefined;
    }
  | {
      readonly kind: 'percent';
      readonly basisPoints: bigint;
      readonly roundToPoisha?: bigint | undefined;
    };

export type PriceRuleOutcome =
  | { readonly ok: true; readonly value: Poisha }
  | { readonly ok: false; readonly reason: 'not-positive' | 'too-large' };

/** The nearest multiple of `step` (half away from zero); `step` ≤ 0 leaves it alone. */
export function roundToStep(value: bigint, step: bigint | undefined): bigint {
  if (step === undefined || step <= 0n) return value;
  return divideRounded(value, step) * step;
}

/** What one rule makes of one amount. Refuses a result of zero or less, never clamps. */
export function applyPriceRule(current: bigint, rule: PriceRule): PriceRuleOutcome {
  let next: bigint;
  switch (rule.kind) {
    case 'set':
      next = rule.amountPoisha;
      break;
    case 'add':
      next = current + rule.amountPoisha;
      break;
    case 'percent':
      next = current + divideRounded(current * rule.basisPoints, BASIS_POINTS);
      break;
  }
  next = roundToStep(next, rule.roundToPoisha);
  if (next <= 0n) return { ok: false, reason: 'not-positive' };
  if (next > PRICE_BOUND_POISHA) return { ok: false, reason: 'too-large' };
  return { ok: true, value: next as Poisha };
}

/** One variant as the bulk editor sees it: its selling price and its regular price. */
export interface PricedVariant {
  readonly skuId: string;
  readonly pricePoisha: bigint;
  /** The regular ("was") price, or null when the variant has none. */
  readonly compareAtPoisha: bigint | null;
}

/** Which of the two prices a rule changes. */
export type PriceField = 'price' | 'compareAt';

export interface PlannedPrice {
  readonly skuId: string;
  readonly fromPoisha: bigint | null;
  readonly toPoisha: bigint;
}

export interface PriceProblem {
  readonly skuId: string;
  readonly reason: 'not-positive' | 'too-large' | 'regular-not-above-price';
}

export interface PricePlan {
  /** Only the variants whose figure actually changes. */
  readonly changes: readonly PlannedPrice[];
  readonly problems: readonly PriceProblem[];
  /** Chosen variants whose figure the rule leaves as it was. */
  readonly unchanged: number;
}

/**
 * The preview of a bulk change: what each chosen variant's price (or regular price) becomes.
 *
 * A variant whose result would be zero or less is a problem, not a clamp: the person sees
 * which ones and why, and nothing is saved until there are none. So is a result that would
 * leave a regular price at or below the selling price, because the database refuses that
 * (`skus_compare_at_above_price`) and a struck-through price no higher than the real one
 * is not a saving. A regular-price rule skips variants that have no regular price unless it
 * is a `set`, which gives them one.
 */
export function planBulkPrices(
  variants: readonly PricedVariant[],
  chosen: ReadonlySet<string>,
  rule: PriceRule,
  field: PriceField = 'price',
): PricePlan {
  const changes: PlannedPrice[] = [];
  const problems: PriceProblem[] = [];
  let unchanged = 0;
  for (const variant of variants) {
    if (!chosen.has(variant.skuId)) continue;
    const current = field === 'price' ? variant.pricePoisha : variant.compareAtPoisha;
    if (current === null && rule.kind !== 'set') {
      unchanged += 1;
      continue;
    }
    const outcome = applyPriceRule(current ?? 0n, rule);
    if (!outcome.ok) {
      problems.push({ skuId: variant.skuId, reason: outcome.reason });
      continue;
    }
    const price = field === 'price' ? outcome.value : variant.pricePoisha;
    const regular = field === 'price' ? variant.compareAtPoisha : outcome.value;
    if (regular !== null && regular <= price) {
      problems.push({ skuId: variant.skuId, reason: 'regular-not-above-price' });
      continue;
    }
    if (outcome.value === current) {
      unchanged += 1;
      continue;
    }
    changes.push({ skuId: variant.skuId, fromPoisha: current, toPoisha: outcome.value });
  }
  return { changes, problems, unchanged };
}

// --- regular (compare-at) price (D-640) ----------------------------------------------------

/**
 * Why a regular price cannot sit beside this selling price, or null when it can.
 *
 * A regular price is optional; when set it must be above the selling price (a "was ৳1,890,
 * now ৳1,490" where the was is no higher is no saving) and within the catalog's bound. The
 * same rule is a CHECK on `catalog.skus`.
 */
export function compareAtProblem(
  pricePoisha: bigint,
  compareAtPoisha: bigint | null,
): 'regular-not-above-price' | 'too-large' | null {
  if (compareAtPoisha === null) return null;
  if (compareAtPoisha > PRICE_BOUND_POISHA) return 'too-large';
  if (compareAtPoisha <= pricePoisha) return 'regular-not-above-price';
  return null;
}

// --- the new-product grid's quick fills (D-635) --------------------------------------------

/**
 * The price a row of the new-product grid starts at: the row's own figure, else the price
 * typed for its size, else for its colour, else the main price. Null when nothing applies.
 */
export function gridPrice(
  own: bigint | null,
  bySize: bigint | null,
  byColour: bigint | null,
  main: bigint | null,
): bigint | null {
  return own ?? bySize ?? byColour ?? main;
}

// --- buying price prefill (D-637, D-638) ---------------------------------------------------

export type PrefillSource = 'supplier-standard' | 'standard' | 'last';

/**
 * What a receipt line's cost starts at: the variant's standard buying price for this supplier,
 * else its standard buying price for any supplier, else the last price it was bought at, else
 * nothing (the person types it). Only ever a starting figure: the cost that enters the books
 * is the one on the posted receipt (invariant 5), whatever was prefilled.
 */
export function prefillUnitCost(input: {
  readonly supplierStandard: bigint | null;
  readonly standard: bigint | null;
  readonly last: bigint | null;
}): { readonly unitCostPoisha: bigint | null; readonly source: PrefillSource | null } {
  if (input.supplierStandard !== null && input.supplierStandard > 0n) {
    return { unitCostPoisha: input.supplierStandard, source: 'supplier-standard' };
  }
  if (input.standard !== null && input.standard > 0n) {
    return { unitCostPoisha: input.standard, source: 'standard' };
  }
  if (input.last !== null && input.last > 0n) return { unitCostPoisha: input.last, source: 'last' };
  return { unitCostPoisha: null, source: null };
}

// --- margin (D-636) -----------------------------------------------------------------------

/**
 * The margin on a selling price, in basis points: (price − cost) / price, half away from
 * zero. Null when there is no price to divide by. Negative when the variant sells below
 * cost.
 *
 * Computed in the browser from a cost the role may already read (invariant 5): no route
 * sends a margin, because a margin and a price are a cost.
 */
export function marginBps(pricePoisha: bigint, costPoisha: bigint): bigint | null {
  if (pricePoisha <= 0n) return null;
  return divideRounded((pricePoisha - costPoisha) * BASIS_POINTS, pricePoisha);
}

/** Basis points as a percentage with one decimal, `4567n` → `"45.7"`, `-50n` → `"-0.5"`. */
export function bpsPercentText(bps: bigint): string {
  const tenths = divideRounded(bps, 10n);
  const negative = tenths < 0n;
  const magnitude = negative ? -tenths : tenths;
  return `${negative ? '-' : ''}${(magnitude / 10n).toString()}.${(magnitude % 10n).toString()}`;
}

/** A percentage a person typed (`10`, `12.5`, `-7.25`) as basis points, or null. */
export function percentTextToBps(text: string): bigint | null {
  const match = /^\s*(-|\+)?(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (match === null) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -bps : bps;
}

// --- prices for variants added later (D-639) -----------------------------------------------

/** A variant that exists, as `newVariantPrice` weighs it. */
export interface ExistingVariantPrice {
  readonly valueIds: readonly string[];
  readonly pricePoisha: bigint;
  readonly active: boolean;
}

/** The price most variants carry; a tie goes to the higher price (never the cheapest). */
export function mostCommonPrice(prices: readonly bigint[]): bigint | null {
  const counts = new Map<bigint, number>();
  for (const price of prices) counts.set(price, (counts.get(price) ?? 0) + 1);
  let best: bigint | null = null;
  let bestCount = 0;
  for (const [price, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && price > best)) {
      best = price;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The price a variant added to an existing product starts at (D-639).
 *
 * The same size's price in the product's other colours (the price most of those active
 * variants carry), else the main price the person gave, else the price most of the product's
 * active variants carry. Never the cheapest variant's price and never an archived variant's:
 * an XXL added beside a ৳1,590 XXL/Red is ৳1,590, not the ৳990 clearance S.
 *
 * `sizeValueIds` are the value ids of the brand's size lists; a new variant with no size
 * value has no "same size" to follow.
 */
export function newVariantPrice(
  valueIds: readonly string[],
  sizeValueIds: ReadonlySet<string>,
  existing: readonly ExistingVariantPrice[],
  main: bigint | null,
): bigint | null {
  const active = existing.filter((variant) => variant.active);
  const size = valueIds.find((id) => sizeValueIds.has(id));
  if (size !== undefined) {
    const siblings = active.filter((variant) => variant.valueIds.includes(size));
    const price = mostCommonPrice(siblings.map((variant) => variant.pricePoisha));
    if (price !== null) return price;
  }
  return main ?? mostCommonPrice(active.map((variant) => variant.pricePoisha));
}

// --- the order of a product's axes (D-639) -------------------------------------------------

/**
 * The attribute order a product's SKU codes were built in, read back from one of its codes.
 *
 * A SKU code ends with one segment per axis, in axis order (`…-0007-XL-RED`). The last N
 * segments of an existing code, N being how many values the SKU has, are matched to its
 * values by code, so variants added later are coded in the same order as the first ones
 * whatever order a caller lists the axes in. A segment that matches no value (a code kept
 * from an old system) leaves that attribute to be ordered by the caller.
 */
export function axisOrderFromCode(
  code: string,
  values: readonly { readonly attributeId: string; readonly valueCode: string }[],
): string[] {
  if (values.length === 0) return [];
  const segments = code.split('-').slice(-values.length);
  const unused = [...values];
  const order: string[] = [];
  for (const segment of segments) {
    const index = unused.findIndex((value) => value.valueCode === segment);
    if (index === -1) continue;
    const [value] = unused.splice(index, 1);
    if (value !== undefined) order.push(value.attributeId);
  }
  return order;
}

/** Size before colour before the rest: the order the new-product form builds codes in. */
export function attributeKindRank(kind: string): number {
  return kind === 'size' ? 0 : kind === 'colour' ? 1 : 2;
}
