import type { IsoDate } from '../dates/index.js';
import { allocate, percentOf, poisha, sum, ZERO, type Poisha } from '../money/index.js';

/**
 * Discounts: what a basket is entitled to, in integer poisha (M35a, D-540; §10).
 *
 * One engine for the order desk's promo codes (M16) and the website's discounts (the old
 * site's `lib/discounts.js`, ported). Two layers:
 *
 * - `evaluateDiscount` answers for one discount: does it apply to this basket, and for how
 *   much off the goods and off the delivery charge, or which rule refused it.
 * - `computeDiscounts` takes every candidate (the brand's live automatic discounts and the
 *   codes the buyer typed), evaluates each, and applies either the single best one or every
 *   stackable one together when together they save at least as much. That is the old site's
 *   rule, with its two arithmetic slips fixed (see `chooseStack`).
 *
 * **Rounding (D-540).** Every percentage is `percentOf`, half away from zero to the poisha,
 * once per discount: a buy-X-get-Y discount rounds the sum of its discounted units, not
 * each unit. The old engine did the same sums in float taka and rounded to two decimals
 * with an epsilon nudge, so the two agree to the poisha except where the exact amount is a
 * half poisha, which float taka could round either way. The differential test asserts
 * exactly that and nothing looser.
 *
 * Pure (invariant 11): no clock, no database. The caller loads the discounts, each line's
 * product and category ancestry, the usage counts and whether this is the buyer's first
 * order, and passes them in.
 */

export const DISCOUNT_KINDS = [
  'percent',
  'flat',
  'free_delivery',
  'buy_x_get_y',
  'tiered',
] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/** A code applies when the buyer types it; an automatic discount whenever it is eligible. */
export const DISCOUNT_METHODS = ['code', 'automatic'] as const;
export type DiscountMethod = (typeof DISCOUNT_METHODS)[number];

export const DISCOUNT_STATUSES = ['active', 'paused', 'archived'] as const;
export type DiscountStatus = (typeof DISCOUNT_STATUSES)[number];

/** One step of a tiered discount: from this subtotal up, this much off. */
export interface DiscountTier {
  readonly minSubtotalPoisha: Poisha;
  readonly kind: 'percent' | 'flat';
  /** Percent tiers: 1–10,000 basis points. */
  readonly valueBps: number;
  /** Flat tiers: the amount off. */
  readonly valuePoisha: Poisha;
}

export interface Discount {
  readonly id: string;
  readonly method: DiscountMethod;
  /** The word a buyer types, upper-case; null for an automatic discount. */
  readonly code: string | null;
  readonly kind: DiscountKind;
  /** Percent: basis points, 1–10,000. */
  readonly valueBps: number;
  /** Flat: the amount off. */
  readonly valuePoisha: Poisha;
  /** Buy X get Y: in every group of `buy + get` units in scope, the `get` cheapest are discounted. */
  readonly buyQuantity: number;
  readonly getQuantity: number;
  /** How much off each of those units: 10,000 is free. */
  readonly getDiscountBps: number;
  /** Tiered: the step whose minimum the whole basket reaches, the highest such step. */
  readonly tiers: readonly DiscountTier[];
  /** On the whole basket, before any discount here. */
  readonly minOrderPoisha: Poisha | null;
  /** Units in the whole basket. */
  readonly minQuantity: number | null;
  readonly firstOrderOnly: boolean;
  /** A ceiling on what this discount gives, whatever its kind; on the delivery for free delivery. */
  readonly maxDiscountPoisha: Poisha | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  /** Asia/Dhaka calendar dates, both inclusive (M16's codes). */
  readonly validFrom: IsoDate | null;
  readonly validTo: IsoDate | null;
  /** Instants, both inclusive (the old site's schedule). Either window, both, or neither. */
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  /** Empty: every channel. */
  readonly channels: readonly string[];
  /** All three empty: the whole basket. Otherwise a line is in scope if any one matches. */
  readonly skuIds: readonly string[];
  readonly productIds: readonly string[];
  /** A category covers its sub-categories: lines carry their category's ancestry. */
  readonly categoryIds: readonly string[];
  /** A personal code belongs to one buyer and to nobody else. */
  readonly customerId: string | null;
  /** May combine with other stackable discounts. */
  readonly allowStacking: boolean;
  /** Higher wins a tie between equally good choices, and is applied first. */
  readonly priority: number;
  readonly status: DiscountStatus;
}

export interface DiscountLine {
  readonly skuId: string;
  readonly productId: string | null;
  /** The line's category and every category above it; empty when it has none. */
  readonly categoryIds: readonly string[];
  /** Whole units, at least one. */
  readonly qty: number;
  /** What the buyer pays for the whole line before any discount here. */
  readonly netPoisha: Poisha;
}

export interface DiscountBasket {
  readonly lines: readonly DiscountLine[];
  readonly deliveryChargePoisha: Poisha;
  readonly channel: string;
  readonly customerId: string | null;
  /** Whether the buyer has no earlier order. The caller decides (the engine has no history). */
  readonly isFirstOrder: boolean;
  /** The Asia/Dhaka business date the order is taken on, for date windows. */
  readonly on: IsoDate;
  /** The instant it is taken, for instant windows. */
  readonly now: Date;
}

export interface DiscountUsage {
  /** Uses applied and not released, across every buyer. */
  readonly total: number;
  /** Of those, this buyer's. Zero for a buyer the brand has never seen. */
  readonly byCustomer: number;
}

/**
 * Why a discount does not apply, in the order the checks run: the first failure is the
 * reason, so a paused code is "inactive" even if it has also expired. M16's ten reasons keep
 * their words and places; M35a's two sit where the old site checked them.
 */
export const DISCOUNT_REASONS = [
  'inactive',
  'not_yet_valid',
  'expired',
  'personal_code',
  'wrong_channel',
  'limit_reached',
  'customer_limit_reached',
  'first_order_only',
  'min_order_not_met',
  'min_quantity_not_met',
  'out_of_scope',
  'nothing_to_discount',
] as const;

export type DiscountReason = (typeof DISCOUNT_REASONS)[number];

export type DiscountVerdict =
  | {
      readonly ok: true;
      /** Off the goods. */
      readonly discountPoisha: Poisha;
      /** Off the delivery charge: free delivery only. */
      readonly deliveryDiscountPoisha: Poisha;
    }
  | { readonly ok: false; readonly reason: DiscountReason };

function refuse(reason: DiscountReason): DiscountVerdict {
  return { ok: false, reason };
}

function min(a: Poisha, b: Poisha): Poisha {
  return a < b ? a : b;
}

function capped(amount: Poisha, cap: Poisha | null): Poisha {
  return cap !== null && cap < amount ? cap : amount;
}

function isScoped(discount: Discount): boolean {
  return (
    discount.skuIds.length > 0 || discount.productIds.length > 0 || discount.categoryIds.length > 0
  );
}

function inScope(discount: Discount, line: DiscountLine): boolean {
  if (!isScoped(discount)) return true;
  return (
    discount.skuIds.includes(line.skuId) ||
    (line.productId !== null && discount.productIds.includes(line.productId)) ||
    line.categoryIds.some((category) => discount.categoryIds.includes(category))
  );
}

interface UnitGroup {
  readonly price: bigint;
  readonly count: number;
}

/**
 * The units of the lines as groups of one price each, cheapest first.
 *
 * A line's net split evenly across its units, as `allocate` splits it: `net = qty × base +
 * extra` gives `extra` units at `base + 1` and the rest at `base`, so units sum to the net
 * exactly however the agent discounted the line. Grouped rather than one entry per unit, so
 * a line of ten thousand is two groups and not ten thousand numbers to sort (ledger audit
 * W13); the multiset is the same one `allocate` gives.
 */
function unitGroups(lines: readonly DiscountLine[]): UnitGroup[] {
  const groups: UnitGroup[] = [];
  for (const line of lines) {
    if (line.qty <= 0 || line.netPoisha < 0n) continue;
    const qty = BigInt(line.qty);
    const base = line.netPoisha / qty;
    const extra = Number(line.netPoisha % qty);
    if (extra > 0) groups.push({ price: base + 1n, count: extra });
    if (line.qty - extra > 0) groups.push({ price: base, count: line.qty - extra });
  }
  return groups.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
}

/** The sum of the `count` cheapest units. */
function cheapest(groups: readonly UnitGroup[], count: number): Poisha {
  let left = count;
  let total = 0n;
  for (const group of groups) {
    if (left <= 0) break;
    const take = Math.min(left, group.count);
    total += group.price * BigInt(take);
    left -= take;
  }
  return poisha(total);
}

/** The tier the whole basket reaches: the highest minimum at or below it, first-listed on a tie. */
function tierFor(tiers: readonly DiscountTier[], subtotal: Poisha): DiscountTier | undefined {
  const ordered = tiers
    .map((tier, index) => ({ tier, index }))
    .sort((a, b) =>
      a.tier.minSubtotalPoisha === b.tier.minSubtotalPoisha
        ? a.index - b.index
        : a.tier.minSubtotalPoisha > b.tier.minSubtotalPoisha
          ? -1
          : 1,
    );
  return ordered.find((entry) => subtotal >= entry.tier.minSubtotalPoisha)?.tier;
}

/** What the discount takes off the goods, before its ceiling. */
function goodsAmount(
  discount: Discount,
  scoped: readonly DiscountLine[],
  subtotal: Poisha,
): Poisha {
  const scopedSubtotal = sum(scoped.map((line) => line.netPoisha));
  switch (discount.kind) {
    case 'percent':
      return percentOf(scopedSubtotal, discount.valueBps);
    case 'flat':
      return min(discount.valuePoisha, scopedSubtotal);
    case 'buy_x_get_y': {
      if (discount.buyQuantity <= 0 || discount.getQuantity <= 0) return ZERO;
      const groups = unitGroups(scoped);
      const units = groups.reduce((total, group) => total + group.count, 0);
      const sets = Math.floor(units / (discount.buyQuantity + discount.getQuantity));
      return percentOf(cheapest(groups, sets * discount.getQuantity), discount.getDiscountBps);
    }
    case 'tiered': {
      const tier = tierFor(discount.tiers, subtotal);
      if (tier === undefined) return ZERO;
      return tier.kind === 'percent'
        ? percentOf(scopedSubtotal, tier.valueBps)
        : min(tier.valuePoisha, scopedSubtotal);
    }
    case 'free_delivery':
      return ZERO;
  }
}

/**
 * One discount against one basket: whether it applies, and for how much.
 *
 * The checks run in `DISCOUNT_REASONS` order. A free-delivery discount on an order with no
 * delivery charge is refused as `nothing_to_discount` (M16's rule at the desk) rather than
 * applied at no value, which is the one place this differs from the old site in what it
 * reports; in money the two are the same.
 */
export function evaluateDiscount(
  discount: Discount,
  basket: DiscountBasket,
  usage: DiscountUsage,
): DiscountVerdict {
  if (discount.status !== 'active') return refuse('inactive');
  if (discount.validFrom !== null && basket.on < discount.validFrom) return refuse('not_yet_valid');
  if (discount.startsAt !== null && basket.now < discount.startsAt) return refuse('not_yet_valid');
  if (discount.validTo !== null && basket.on > discount.validTo) return refuse('expired');
  if (discount.endsAt !== null && basket.now > discount.endsAt) return refuse('expired');
  if (discount.customerId !== null && discount.customerId !== basket.customerId) {
    return refuse('personal_code');
  }
  if (discount.channels.length > 0 && !discount.channels.includes(basket.channel)) {
    return refuse('wrong_channel');
  }
  if (discount.totalLimit !== null && usage.total >= discount.totalLimit) {
    return refuse('limit_reached');
  }
  if (discount.perCustomerLimit !== null && usage.byCustomer >= discount.perCustomerLimit) {
    return refuse('customer_limit_reached');
  }
  if (discount.firstOrderOnly && !basket.isFirstOrder) return refuse('first_order_only');

  const subtotal = sum(basket.lines.map((line) => line.netPoisha));
  if (discount.minOrderPoisha !== null && subtotal < discount.minOrderPoisha) {
    return refuse('min_order_not_met');
  }
  const quantity = basket.lines.reduce((total, line) => total + line.qty, 0);
  if (discount.minQuantity !== null && quantity < discount.minQuantity) {
    return refuse('min_quantity_not_met');
  }

  const scoped = basket.lines.filter((line) => inScope(discount, line));
  if (isScoped(discount) && scoped.length === 0) return refuse('out_of_scope');

  if (discount.kind === 'free_delivery') {
    if (basket.deliveryChargePoisha <= 0n) return refuse('nothing_to_discount');
    return {
      ok: true,
      discountPoisha: ZERO,
      deliveryDiscountPoisha: capped(basket.deliveryChargePoisha, discount.maxDiscountPoisha),
    };
  }

  const amount = capped(goodsAmount(discount, scoped, subtotal), discount.maxDiscountPoisha);
  if (amount <= 0n) return refuse('nothing_to_discount');
  return { ok: true, discountPoisha: poisha(amount), deliveryDiscountPoisha: ZERO };
}

/** Codes are matched without regard to case or surrounding spaces: people type them. */
export function normaliseCode(input: string): string {
  return input.trim().toUpperCase();
}

export interface AppliedDiscount {
  readonly discount: Discount;
  readonly discountPoisha: Poisha;
  readonly deliveryDiscountPoisha: Poisha;
}

export interface RefusedCode {
  readonly code: string;
  readonly reason: DiscountReason;
}

export interface DiscountsResult {
  /** What applies, highest priority first. Every entry gives something. */
  readonly applied: readonly AppliedDiscount[];
  /** Codes the buyer typed that did not apply, and why. Automatic discounts never appear. */
  readonly refused: readonly RefusedCode[];
  /** Off the goods, never more than the basket. */
  readonly discountPoisha: Poisha;
  /** Off the delivery charge, never more than the charge. */
  readonly deliveryDiscountPoisha: Poisha;
}

export interface DiscountsInput {
  /** The candidates: live automatic discounts and the discounts the typed codes name. */
  readonly discounts: readonly Discount[];
  readonly basket: DiscountBasket;
  /** The codes the buyer typed, however they typed them. */
  readonly codes: readonly string[];
  /** Usage per discount id; a discount absent here has never been used. */
  readonly usage: ReadonlyMap<string, DiscountUsage>;
}

const NEVER_USED: DiscountUsage = { total: 0, byCustomer: 0 };

interface Candidate {
  readonly discount: Discount;
  readonly discountPoisha: Poisha;
  readonly deliveryDiscountPoisha: Poisha;
}

/** Priority first, then the id, so the answer never depends on the order rows arrived in. */
function byPriority(a: Candidate, b: Candidate): number {
  if (a.discount.priority !== b.discount.priority) return b.discount.priority - a.discount.priority;
  return a.discount.id < b.discount.id ? -1 : a.discount.id > b.discount.id ? 1 : 0;
}

function valueOf(candidate: Candidate): Poisha {
  return poisha(candidate.discountPoisha + candidate.deliveryDiscountPoisha);
}

/**
 * The stackable candidates applied together, each trimmed to what is left to give.
 *
 * Each line can lose at most what it costs. A stacked discount is taken off **its own
 * lines**, in priority order: it gives at most what is still left on the lines in its scope,
 * and what it gives comes off those lines in proportion to what each has left (`allocate`,
 * so no line goes below zero). Two ৳500 discounts on a ৳600 panjabi therefore give ৳600
 * between them, never ৳1,000 with the excess off a shirt neither covers (ledger audit W1).
 * A delivery charge is waived once, by the stackable discount that waives the most of it.
 *
 * The old engine summed a stack's members and capped the sum at the whole basket only, so
 * it over-gave on scoped stacks, counted the delivery charge once per free-shipping member,
 * and counted goods beyond the basket; each could make it choose a stack worth less than
 * the best single discount. Valued as what it actually gives, a stack is chosen only when it
 * is at least as good (D-540).
 */
function chooseStack(
  stackables: readonly Candidate[],
  lines: readonly DiscountLine[],
): Candidate[] {
  const left: Poisha[] = lines.map((line) => (line.netPoisha > 0n ? line.netPoisha : ZERO));
  let waiver: Candidate | undefined;
  for (const candidate of stackables) {
    if (candidate.deliveryDiscountPoisha > (waiver?.deliveryDiscountPoisha ?? 0n)) {
      waiver = candidate;
    }
  }
  const trimmed: Candidate[] = [];
  for (const candidate of stackables) {
    const scope = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => inScope(candidate.discount, entry.line))
      .map((entry) => entry.index);
    const room = sum(scope.map((index) => left[index] ?? ZERO));
    const goods = min(candidate.discountPoisha, room);
    if (goods > 0n) {
      const parts = allocate(
        goods,
        scope.map((index) => left[index] ?? ZERO),
      );
      scope.forEach((lineIndex, at) => {
        left[lineIndex] = poisha((left[lineIndex] ?? ZERO) - (parts[at] ?? ZERO));
      });
    }
    const delivery = candidate === waiver ? candidate.deliveryDiscountPoisha : ZERO;
    if (goods > 0n || delivery > 0n) {
      trimmed.push({
        discount: candidate.discount,
        discountPoisha: goods,
        deliveryDiscountPoisha: delivery,
      });
    }
  }
  return trimmed;
}

/**
 * Every discount a basket gets: the best single one, or all the stackable ones together if
 * together they give at least as much (the old site's strategy; D-540).
 *
 * A code discount is a candidate only when its code was typed; an automatic one whenever it
 * is eligible. A typed code that matches no discount is the caller's to report (it has to
 * look the word up to know); a code that matches but does not apply comes back in `refused`.
 */
export function computeDiscounts(input: DiscountsInput): DiscountsResult {
  const entered = new Set(input.codes.map(normaliseCode).filter((code) => code !== ''));
  const refused: RefusedCode[] = [];
  const candidates: Candidate[] = [];

  for (const discount of input.discounts) {
    if (discount.method === 'code') {
      if (discount.code === null || !entered.has(normaliseCode(discount.code))) continue;
    }
    const verdict = evaluateDiscount(
      discount,
      input.basket,
      input.usage.get(discount.id) ?? NEVER_USED,
    );
    if (!verdict.ok) {
      if (discount.method === 'code' && discount.code !== null) {
        refused.push({ code: discount.code, reason: verdict.reason });
      }
      continue;
    }
    candidates.push({
      discount,
      discountPoisha: verdict.discountPoisha,
      deliveryDiscountPoisha: verdict.deliveryDiscountPoisha,
    });
  }

  if (candidates.length === 0) {
    return { applied: [], refused, discountPoisha: ZERO, deliveryDiscountPoisha: ZERO };
  }

  const ordered = [...candidates].sort(byPriority);
  // The best single: most value, then priority, then id. A stable sort over `ordered`.
  // `ordered` is not empty: there is at least one candidate.
  const best = [...ordered].sort((a, b) => {
    const difference = valueOf(b) - valueOf(a);
    return difference === 0n ? 0 : difference > 0n ? 1 : -1;
  })[0]!;

  const stackables = ordered.filter((candidate) => candidate.discount.allowStacking);
  const stack = chooseStack(stackables, input.basket.lines);
  const stackValue = sum(stack.map(valueOf));
  const applied = stackables.length >= 2 && stackValue >= valueOf(best) ? stack : [best];

  return {
    applied,
    refused,
    discountPoisha: sum(applied.map((entry) => entry.discountPoisha)),
    deliveryDiscountPoisha: sum(applied.map((entry) => entry.deliveryDiscountPoisha)),
  };
}
