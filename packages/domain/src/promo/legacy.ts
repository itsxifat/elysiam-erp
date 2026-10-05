import { decimalToPoisha, poisha, ZERO, type Poisha } from '../money/index.js';
import type { Discount, DiscountKind, DiscountTier } from './discounts.js';

/**
 * The old website's discount documents, read as ERP discounts (M35a, D-540).
 *
 * The old site kept money as float taka and percentages as float percents. This is the one
 * place they become poisha and basis points, so the differential test against the old
 * engine and M36's import of the old data agree on what each old discount means:
 *
 * - `value` is percent (0–100) or taka by type; `maxDiscount` is the cap for a
 *   **percentage** discount only (the old admin's own words: "cap for percentage"), so it is
 *   dropped for the other kinds rather than given a meaning they never had.
 * - zero means "none" for every limit and minimum, as it did there.
 * - `getDiscountPercent` of 0 meant 100 (`|| 100`), and still does.
 * - `appliesTo` picks one of products or categories; ids pass through `ids` so the import
 *   can map Mongo ids to the ERP's.
 * - `active: false` is `paused`: the old admin's off switch, which could be turned back on.
 */

export interface OldSiteTier {
  readonly minSubtotal?: number;
  readonly type?: 'percentage' | 'fixed';
  readonly value?: number;
}

export interface OldSiteDiscount {
  readonly _id?: unknown;
  readonly id?: unknown;
  readonly title?: string;
  readonly method?: 'code' | 'automatic';
  readonly code?: string | null;
  readonly type?: 'percentage' | 'fixed' | 'free_shipping' | 'buy_x_get_y' | 'tiered';
  readonly value?: number;
  readonly maxDiscount?: number;
  readonly buyQuantity?: number;
  readonly getQuantity?: number;
  readonly getDiscountPercent?: number;
  readonly tiers?: readonly OldSiteTier[];
  readonly appliesTo?: 'all' | 'products' | 'categories';
  readonly products?: readonly unknown[];
  readonly categories?: readonly unknown[];
  readonly minSubtotal?: number;
  readonly minQuantity?: number;
  readonly firstOrderOnly?: boolean;
  readonly usageLimit?: number;
  readonly perCustomerLimit?: number;
  readonly startsAt?: Date | string | null;
  readonly endsAt?: Date | string | null;
  readonly allowStacking?: boolean;
  readonly priority?: number;
  readonly active?: boolean;
}

export interface OldSiteIds {
  readonly product: (oldId: string) => string;
  readonly category: (oldId: string) => string;
}

const SAME_IDS: OldSiteIds = { product: (id) => id, category: (id) => id };

/**
 * The scope of an old discount limited to products or categories with none listed. The old
 * engine found nothing in scope and refused it; an empty list here would mean the whole
 * basket, so the nil uuid, which names no product or category, stands for "nothing".
 */
export const NOTHING_IN_SCOPE = '00000000-0000-0000-0000-000000000000';

function scopeOf(list: readonly unknown[] | undefined, map: (id: string) => string): string[] {
  const ids = (list ?? []).map((id) => map(String(id)));
  return ids.length === 0 ? [NOTHING_IN_SCOPE] : ids;
}

const KINDS: Readonly<Record<NonNullable<OldSiteDiscount['type']>, DiscountKind>> = {
  percentage: 'percent',
  fixed: 'flat',
  free_shipping: 'free_delivery',
  buy_x_get_y: 'buy_x_get_y',
  tiered: 'tiered',
};

/**
 * A float amount of taka as poisha, from its decimal text, rounded once to the poisha by the
 * system's one rule. Anything that is not a plain positive amount (an exponent, a negative,
 * NaN) is 0, as the old site's `Number(x) || 0` treated it.
 *
 * Float noise (`0.1 + 0.2` prints as `0.30000000000000004`) has more fraction digits than
 * `decimalToPoisha` takes, so the text is cut to twelve: a difference below 10⁻¹² taka,
 * which the rounding to the poisha then removes (ledger audit W9).
 */
export function oldTakaToPoisha(value: number | undefined): Poisha {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ZERO;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (match === null) return ZERO;
  const [, whole = '0', fraction = ''] = match;
  return decimalToPoisha(fraction === '' ? whole : `${whole}.${fraction.slice(0, 12)}`);
}

/** A float percent as basis points (`12.5` → 1250), clamped to 0–10,000. */
export function oldPercentToBps(value: number | undefined): number {
  // Percent × 100 is the same shift as taka × 100, and rounds by the same one rule.
  const bps = Number(oldTakaToPoisha(value));
  return Math.min(bps, 10_000);
}

function positive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function instant(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function idText(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'toHexString' in value) {
    const hex = (value as { toHexString: () => unknown }).toHexString();
    if (typeof hex === 'string') return hex;
  }
  return typeof value === 'number' || typeof value === 'bigint' ? value.toString() : '';
}

function tierFromOldSite(tier: OldSiteTier): DiscountTier {
  const percent = tier.type !== 'fixed';
  return {
    minSubtotalPoisha: oldTakaToPoisha(tier.minSubtotal),
    kind: percent ? 'percent' : 'flat',
    valueBps: percent ? oldPercentToBps(tier.value) : 0,
    valuePoisha: percent ? ZERO : oldTakaToPoisha(tier.value),
  };
}

export function discountFromOldSite(doc: OldSiteDiscount, ids: OldSiteIds = SAME_IDS): Discount {
  const kind = KINDS[doc.type ?? 'percentage'];
  const method = doc.method ?? 'code';
  const code =
    method === 'code' && typeof doc.code === 'string' && doc.code.trim() !== ''
      ? doc.code.trim().toUpperCase()
      : null;
  const appliesTo = doc.appliesTo ?? 'all';
  const maxDiscount = oldTakaToPoisha(doc.maxDiscount);
  const getPercent = doc.getDiscountPercent ?? 0;
  const rawId = doc._id ?? doc.id ?? '';

  return {
    // A Mongo ObjectId prints as its hex; anything else that is not text has no usable id.
    id: typeof rawId === 'string' ? rawId : idText(rawId),
    method,
    code,
    kind,
    valueBps: kind === 'percent' ? oldPercentToBps(doc.value) : 0,
    valuePoisha: kind === 'flat' ? oldTakaToPoisha(doc.value) : ZERO,
    buyQuantity: positive(doc.buyQuantity) ?? 0,
    getQuantity: positive(doc.getQuantity) ?? 0,
    getDiscountBps: getPercent > 0 ? oldPercentToBps(getPercent) : 10_000,
    tiers: (doc.tiers ?? []).map(tierFromOldSite),
    minOrderPoisha: positive(doc.minSubtotal) === null ? null : oldTakaToPoisha(doc.minSubtotal),
    minQuantity: positive(doc.minQuantity),
    firstOrderOnly: doc.firstOrderOnly === true,
    maxDiscountPoisha: kind === 'percent' && maxDiscount > 0n ? poisha(maxDiscount) : null,
    totalLimit: positive(doc.usageLimit),
    perCustomerLimit: positive(doc.perCustomerLimit),
    validFrom: null,
    validTo: null,
    startsAt: instant(doc.startsAt),
    endsAt: instant(doc.endsAt),
    channels: [],
    skuIds: [],
    productIds: appliesTo === 'products' ? scopeOf(doc.products, ids.product) : [],
    categoryIds: appliesTo === 'categories' ? scopeOf(doc.categories, ids.category) : [],
    customerId: null,
    allowStacking: doc.allowStacking === true,
    priority: Number.isFinite(doc.priority) ? Math.trunc(doc.priority ?? 0) : 0,
    status: doc.active === false ? 'paused' : 'active',
  };
}
