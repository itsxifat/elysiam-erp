import { takaToPoisha } from '@elysium/ui';

import type { CreatePromoBody, PromoCode, PromoKind, PromoMethod } from './api.js';
import { dhakaLocalToIso } from './dhaka-time.js';
import type { CampaignsMessageKey } from './messages.js';

/**
 * The new-discount form, checked before it is sent (M16, M35a; D-541).
 *
 * The server validates everything again and is the authority; this exists so a marketer
 * sees "enter a percent between 0.01 and 100" beside the field rather than a 400. Pure, so
 * the rules are tested without a browser.
 */

export interface TierValues {
  /** Taka, as typed. */
  readonly minSubtotal: string;
  readonly kind: 'percent' | 'flat';
  /** A percent or taka, by kind. */
  readonly value: string;
}

export type ScopeChoice = 'all' | 'products' | 'categories';

export interface DiscountFormValues {
  readonly method: PromoMethod;
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly kind: PromoKind;
  /** As typed: `10`, `12.5`. */
  readonly percent: string;
  /** Taka as typed, for an amount off. */
  readonly amount: string;
  readonly maxDiscount: string;
  readonly buyQuantity: string;
  readonly getQuantity: string;
  /** Percent off each free unit: 100 is free. */
  readonly getPercent: string;
  readonly tiers: readonly TierValues[];
  readonly scope: ScopeChoice;
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly minOrder: string;
  readonly minQuantity: string;
  readonly firstOrderOnly: boolean;
  readonly totalLimit: string;
  readonly perCustomerLimit: string;
  /** `datetime-local` text, read as Asia/Dhaka. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly channels: readonly string[];
  readonly allowStacking: boolean;
  readonly priority: string;
}

export const EMPTY_DISCOUNT: DiscountFormValues = {
  method: 'code',
  code: '',
  title: '',
  description: '',
  kind: 'percent',
  percent: '',
  amount: '',
  maxDiscount: '',
  buyQuantity: '2',
  getQuantity: '1',
  getPercent: '100',
  tiers: [{ minSubtotal: '', kind: 'percent', value: '' }],
  scope: 'all',
  productIds: [],
  categoryIds: [],
  minOrder: '',
  minQuantity: '',
  firstOrderOnly: false,
  totalLimit: '',
  perCustomerLimit: '',
  startsAt: '',
  endsAt: '',
  channels: [],
  allowStacking: false,
  priority: '0',
};

export type DiscountFormField = Exclude<keyof DiscountFormValues, 'tiers'> | `tier${number}`;

/** The error slot for the tier at `index`. */
export function tierField(index: number): `tier${number}` {
  return `tier${index}`;
}
export type DiscountFormErrors = Partial<Record<DiscountFormField, CampaignsMessageKey>>;

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

/**
 * A typed percent as basis points: `12.5` → 1250. Two decimals at most, 0.01–100.
 *
 * Integer arithmetic on the digits, not `Number(x) * 100`: `0.29 * 100` is
 * `28.999999999999996` in floating point, and a rate is money's cousin.
 */
export function percentToBps(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const bps = whole * 100 + fraction;
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

/** A positive whole number, or undefined for blank. Null means invalid. */
function count(input: string, max = 999_999_999): number | undefined | null {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= max ? value : null;
}

/** Optional taka: undefined when blank, null when not an amount, else poisha. */
function optionalTaka(input: string, positive: boolean): string | undefined | null {
  if (input.trim() === '') return undefined;
  const poisha = takaToPoisha(input);
  if (poisha === null || poisha.startsWith('-')) return null;
  if (positive && BigInt(poisha) === 0n) return null;
  return poisha;
}

/** Whether a kind's value is a rate, so a ceiling on it means something. */
function takesCeiling(kind: PromoKind): boolean {
  return kind === 'percent' || kind === 'buy_x_get_y' || kind === 'tiered';
}

export function checkDiscountForm(
  values: DiscountFormValues,
):
  | { readonly ok: true; readonly body: CreatePromoBody }
  | { readonly ok: false; readonly errors: DiscountFormErrors } {
  const errors: Partial<Record<DiscountFormField, CampaignsMessageKey>> = {};
  const isCode = values.method === 'code';
  const code = values.code.trim();
  const title = values.title.trim();
  if (isCode && !CODE.test(code)) errors.code = 'campaigns.codes.form.invalidCode';
  if (!isCode && title === '') errors.title = 'campaigns.discounts.form.titleRequired';

  const offer: {
    valueBps?: number;
    valuePoisha?: string;
    buyQuantity?: number;
    getQuantity?: number;
    getDiscountBps?: number;
    tiers?: CreatePromoBody['tiers'];
  } = {};
  switch (values.kind) {
    case 'percent': {
      const bps = percentToBps(values.percent);
      if (bps === null) errors.percent = 'campaigns.codes.form.invalidPercent';
      else offer.valueBps = bps;
      break;
    }
    case 'flat': {
      const amount = optionalTaka(values.amount, true);
      if (amount == null) errors.amount = 'campaigns.codes.form.invalidAmount';
      else offer.valuePoisha = amount;
      break;
    }
    case 'buy_x_get_y': {
      const buy = count(values.buyQuantity, 1_000);
      const get = count(values.getQuantity, 1_000);
      const percent = percentToBps(values.getPercent);
      if (buy == null) errors.buyQuantity = 'campaigns.discounts.form.invalidQuantity';
      if (get == null) errors.getQuantity = 'campaigns.discounts.form.invalidQuantity';
      if (percent === null) errors.getPercent = 'campaigns.codes.form.invalidPercent';
      if (buy != null && get != null && percent !== null) {
        offer.buyQuantity = buy;
        offer.getQuantity = get;
        if (percent !== 10_000) offer.getDiscountBps = percent;
      }
      break;
    }
    case 'tiered': {
      const tiers: NonNullable<CreatePromoBody['tiers']>[number][] = [];
      values.tiers.forEach((tier, index) => {
        const min = optionalTaka(tier.minSubtotal, false);
        const bps = tier.kind === 'percent' ? percentToBps(tier.value) : null;
        const amount = tier.kind === 'flat' ? optionalTaka(tier.value, true) : null;
        if (min == null || (tier.kind === 'percent' ? bps === null : amount == null)) {
          errors[tierField(index)] = 'campaigns.discounts.form.invalidTier';
          return;
        }
        tiers.push(
          tier.kind === 'percent'
            ? { minSubtotalPoisha: min, kind: 'percent', valueBps: bps ?? 0 }
            : { minSubtotalPoisha: min, kind: 'flat', valuePoisha: amount ?? '0' },
        );
      });
      if (values.tiers.length === 0) errors.tier0 = 'campaigns.discounts.form.invalidTier';
      offer.tiers = tiers;
      break;
    }
    case 'free_delivery':
      break;
  }

  const minOrder = optionalTaka(values.minOrder, false);
  if (minOrder === null) errors.minOrder = 'campaigns.codes.form.invalidAmount';
  const maxDiscount = optionalTaka(values.maxDiscount, true);
  if (maxDiscount === null) errors.maxDiscount = 'campaigns.codes.form.invalidAmount';
  const minQuantity = count(values.minQuantity, 10_000);
  if (minQuantity === null) errors.minQuantity = 'campaigns.codes.form.invalidCount';
  const totalLimit = count(values.totalLimit);
  if (totalLimit === null) errors.totalLimit = 'campaigns.codes.form.invalidCount';
  const perCustomerLimit = count(values.perCustomerLimit);
  if (perCustomerLimit === null) errors.perCustomerLimit = 'campaigns.codes.form.invalidCount';

  const priorityText = values.priority.trim() === '' ? '0' : values.priority.trim();
  const priority = /^-?\d{1,3}$/.test(priorityText) ? Number(priorityText) : Number.NaN;
  if (!(priority >= -100 && priority <= 100)) {
    errors.priority = 'campaigns.discounts.form.invalidPriority';
  }

  const startsAt = values.startsAt === '' ? undefined : dhakaLocalToIso(values.startsAt);
  const endsAt = values.endsAt === '' ? undefined : dhakaLocalToIso(values.endsAt);
  if (startsAt === null) errors.startsAt = 'campaigns.discounts.form.invalidTime';
  if (endsAt === null) errors.endsAt = 'campaigns.discounts.form.invalidTime';
  if (startsAt != null && endsAt != null && startsAt >= endsAt) {
    errors.endsAt = 'campaigns.codes.form.invalidWindow';
  }

  const picked = values.scope === 'products' ? values.productIds : values.categoryIds;
  const scoped =
    values.scope === 'products'
      ? { productIds: values.productIds }
      : values.scope === 'categories'
        ? { categoryIds: values.categoryIds }
        : {};
  if (values.scope !== 'all' && picked.length === 0) {
    errors.scope = 'campaigns.discounts.form.scopeRequired';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      ...(isCode ? { code } : { method: 'automatic' as const }),
      ...(title === '' ? {} : { title }),
      ...(values.description.trim() === '' ? {} : { description: values.description.trim() }),
      kind: values.kind,
      ...offer,
      ...scoped,
      ...(minOrder == null ? {} : { minOrderPoisha: minOrder }),
      ...(minQuantity == null ? {} : { minQuantity }),
      ...(values.firstOrderOnly ? { firstOrderOnly: true } : {}),
      // A ceiling on a rate; an amount off or free delivery is its own ceiling.
      ...(maxDiscount == null || !takesCeiling(values.kind)
        ? {}
        : { maxDiscountPoisha: maxDiscount }),
      ...(totalLimit == null ? {} : { totalLimit }),
      ...(perCustomerLimit == null ? {} : { perCustomerLimit }),
      ...(startsAt == null ? {} : { startsAt }),
      ...(endsAt == null ? {} : { endsAt }),
      ...(values.channels.length === 0 ? {} : { channels: values.channels }),
      ...(values.allowStacking ? { allowStacking: true } : {}),
      ...(priority === 0 ? {} : { priority }),
    },
  };
}

/** A basis-point rate as people write it: `10%`, `12.5%`, `0.29%`. */
export function percentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = bps % 100;
  return fraction === 0
    ? `${String(whole)}%`
    : `${String(whole)}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`;
}

export type OfferParts =
  | { readonly percent: string }
  | { readonly poisha: string }
  | { readonly freeDelivery: true }
  | { readonly buy: number; readonly get: number; readonly getPercent: string }
  | { readonly tiers: number };

/** How a discount's offer reads in the list: "10%", "৳150.00", "Buy 2 get 1", "3 tiers". */
export function offerParts(
  code: Pick<PromoCode, 'kind' | 'valueBps' | 'valuePoisha'> &
    Partial<Pick<PromoCode, 'buyQuantity' | 'getQuantity' | 'getDiscountBps' | 'tiers'>>,
): OfferParts {
  switch (code.kind) {
    case 'percent':
      return { percent: percentText(code.valueBps ?? 0) };
    case 'flat':
      return { poisha: code.valuePoisha ?? '0' };
    case 'buy_x_get_y':
      return {
        buy: code.buyQuantity ?? 0,
        get: code.getQuantity ?? 0,
        getPercent: percentText(code.getDiscountBps ?? 10_000),
      };
    case 'tiered':
      return { tiers: code.tiers?.length ?? 0 };
    case 'free_delivery':
      return { freeDelivery: true };
  }
}
