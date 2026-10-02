import { takaToPoisha } from '@elysium/ui';

import type { CreatePromoBody, PromoKind } from './api.js';
import type { CampaignsMessageKey } from './messages.js';

/**
 * The new-code form, checked before it is sent (M16).
 *
 * The server validates everything again and is the authority; this exists so a marketer
 * sees "enter a percent between 0.01 and 100" beside the field rather than a 400. Pure, so
 * the rules are tested without a browser.
 */

export interface PromoFormValues {
  readonly code: string;
  readonly kind: PromoKind;
  /** As typed: `10`, `12.5`. */
  readonly percent: string;
  /** Taka as typed, for a flat code. */
  readonly amount: string;
  readonly minOrder: string;
  readonly maxDiscount: string;
  readonly totalLimit: string;
  readonly perCustomerLimit: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly channels: readonly string[];
}

export type PromoFormErrors = Partial<Record<keyof PromoFormValues, CampaignsMessageKey>>;

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

/** A positive whole number of uses, or undefined for "no limit". Null means invalid. */
function count(input: string): number | undefined | null {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 ? value : null;
}

/** Optional taka: undefined when blank, null when not an amount, else poisha. */
function optionalTaka(input: string, positive: boolean): string | undefined | null {
  if (input.trim() === '') return undefined;
  const poisha = takaToPoisha(input);
  if (poisha === null || poisha.startsWith('-')) return null;
  if (positive && BigInt(poisha) === 0n) return null;
  return poisha;
}

export function checkPromoForm(
  values: PromoFormValues,
):
  | { readonly ok: true; readonly body: CreatePromoBody }
  | { readonly ok: false; readonly errors: PromoFormErrors } {
  const errors: { -readonly [K in keyof PromoFormValues]?: CampaignsMessageKey } = {};
  const code = values.code.trim();
  if (!CODE.test(code)) errors.code = 'campaigns.codes.form.invalidCode';

  let valueBps: number | undefined;
  let valuePoisha: string | undefined;
  if (values.kind === 'percent') {
    const bps = percentToBps(values.percent);
    if (bps === null) errors.percent = 'campaigns.codes.form.invalidPercent';
    else valueBps = bps;
  } else if (values.kind === 'flat') {
    const amount = optionalTaka(values.amount, true);
    if (amount === null || amount === undefined)
      errors.amount = 'campaigns.codes.form.invalidAmount';
    else valuePoisha = amount;
  }

  const minOrder = optionalTaka(values.minOrder, false);
  if (minOrder === null) errors.minOrder = 'campaigns.codes.form.invalidAmount';
  const maxDiscount = optionalTaka(values.maxDiscount, true);
  if (maxDiscount === null) errors.maxDiscount = 'campaigns.codes.form.invalidAmount';
  const totalLimit = count(values.totalLimit);
  if (totalLimit === null) errors.totalLimit = 'campaigns.codes.form.invalidCount';
  const perCustomerLimit = count(values.perCustomerLimit);
  if (perCustomerLimit === null) errors.perCustomerLimit = 'campaigns.codes.form.invalidCount';

  const validFrom = values.validFrom === '' ? undefined : values.validFrom;
  const validTo = values.validTo === '' ? undefined : values.validTo;
  if (validFrom !== undefined && validTo !== undefined && validFrom > validTo) {
    errors.validTo = 'campaigns.codes.form.invalidWindow';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      code,
      kind: values.kind,
      ...(valueBps === undefined ? {} : { valueBps }),
      ...(valuePoisha === undefined ? {} : { valuePoisha }),
      ...(minOrder == null ? {} : { minOrderPoisha: minOrder }),
      // A percent code's cap; meaningless on the other kinds, so it is not sent for them.
      ...(maxDiscount == null || values.kind !== 'percent'
        ? {}
        : { maxDiscountPoisha: maxDiscount }),
      ...(totalLimit == null ? {} : { totalLimit }),
      ...(perCustomerLimit == null ? {} : { perCustomerLimit }),
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(validTo === undefined ? {} : { validTo }),
      ...(values.channels.length === 0 ? {} : { channels: values.channels }),
    },
  };
}

/** How a code's offer reads in the list: "10%", "৳150.00", "Free delivery". */
export function offerParts(code: {
  readonly kind: PromoKind;
  readonly valueBps: number | null;
  readonly valuePoisha: string | null;
}): { readonly percent: string } | { readonly poisha: string } | { readonly freeDelivery: true } {
  if (code.kind === 'percent') {
    const bps = code.valueBps ?? 0;
    const whole = Math.trunc(bps / 100);
    const fraction = bps % 100;
    return {
      percent:
        fraction === 0
          ? `${String(whole)}%`
          : `${String(whole)}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`,
    };
  }
  if (code.kind === 'flat') return { poisha: code.valuePoisha ?? '0' };
  return { freeDelivery: true };
}
