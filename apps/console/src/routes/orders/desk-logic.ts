import type { Area } from './api.js';

/**
 * The order desk's pure pieces (M11): phone recognition, area matching and the running
 * totals. Kept out of the component so each can be tested alone — they are the parts of the
 * desk that can be wrong without anything looking wrong.
 */

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** `০১৭১১` → `01711`. Everything else is left alone. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)));
}

/**
 * The typed number as `01XXXXXXXXX`, or null while it is not a Bangladeshi mobile yet.
 *
 * Only for deciding *when* to look the buyer up and whether to enable Save. The server's
 * `normalizeBdPhone` is the rule that decides who the buyer is, and the desk sends what was
 * typed; two definitions of identity would disagree about some spelling, and the server's
 * is the one with the tests. Bangla digits are converted first, because an agent copying a
 * number out of a Bangla chat pastes them.
 */
export function deskPhone(input: string): string | null {
  const digits = toAsciiDigits(input).replace(/\D+/g, '');
  let national = digits;
  if (national.startsWith('00880')) national = national.slice(5);
  else if (national.startsWith('880')) national = national.slice(3);
  if (/^1[3-9]\d{8}$/.test(national)) national = `0${national}`;
  return /^01[3-9]\d{8}$/.test(national) ? national : null;
}

/**
 * Areas matching what was typed, best first.
 *
 * A thana whose name *starts* with the query ranks above one that merely contains it, and a
 * thana match above a district match: "sav" should put Savar first, not every thana in a
 * district whose name happens to contain the letters. Bangla names match too — an agent
 * reading an address out of a Bangla message types it in Bangla.
 */
export function filterAreas(areas: readonly Area[], typed: string, limit = 8): Area[] {
  const needle = typed.trim().toLowerCase();
  if (needle === '') return [];
  const scored: { area: Area; score: number }[] = [];
  for (const area of areas) {
    const thanaEn = area.thanaEn.toLowerCase();
    const districtEn = area.districtEn.toLowerCase();
    let score = -1;
    if (thanaEn.startsWith(needle) || area.thanaBn.startsWith(typed.trim())) score = 0;
    else if (districtEn.startsWith(needle) || area.districtBn.startsWith(typed.trim())) score = 1;
    else if (thanaEn.includes(needle) || area.thanaBn.includes(typed.trim())) score = 2;
    else if (districtEn.includes(needle) || area.districtBn.includes(typed.trim())) score = 3;
    if (score >= 0) scored.push({ area, score });
  }
  return scored
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.area.thanaEn.localeCompare(right.area.thanaEn) ||
        left.area.districtEn.localeCompare(right.area.districtEn),
    )
    .slice(0, limit)
    .map((entry) => entry.area);
}

export interface DeskLine {
  readonly skuId: string;
  readonly skuCode: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPricePoisha: string;
  /** Null until the availability read comes back. */
  readonly availableQty: number | null;
}

export interface TotalsPreview {
  readonly itemsPoisha: string;
  readonly discountPoisha: string;
  readonly deliveryPoisha: string;
  readonly codPoisha: string;
  /** The discount exceeds the items, or the COD would be negative: the server refuses both. */
  readonly invalid: boolean;
}

/**
 * §9's formula, previewed: COD = items − discount + delivery.
 *
 * A **preview**. The server prices the lines from the catalog and computes the totals with
 * `computeOrderTotals` in `packages/domain`, and the saved order's figures replace these the
 * moment it exists (invariant 11). It is here so the agent can read the COD to the buyer
 * before pressing save, and it is `bigint` so a crore-scale order adds up to the poisha.
 */
export function previewTotals(input: {
  readonly lines: readonly DeskLine[];
  readonly discountPoisha: string | null;
  readonly deliveryPoisha: string | null;
}): TotalsPreview {
  const items = input.lines.reduce(
    (total, line) => total + BigInt(line.unitPricePoisha) * BigInt(line.qty),
    0n,
  );
  const discount = BigInt(input.discountPoisha ?? '0');
  const delivery = BigInt(input.deliveryPoisha ?? '0');
  const cod = items - discount + delivery;
  return {
    itemsPoisha: items.toString(),
    discountPoisha: discount.toString(),
    deliveryPoisha: delivery.toString(),
    codPoisha: (cod < 0n ? 0n : cod).toString(),
    invalid: discount < 0n || discount > items || delivery < 0n || cod < 0n,
  };
}

/** Add a SKU, or bump its quantity: the server refuses a SKU twice on one order. */
export function addLine(lines: readonly DeskLine[], next: DeskLine): DeskLine[] {
  const existing = lines.findIndex((line) => line.skuId === next.skuId);
  if (existing < 0) return [...lines, next];
  return lines.map((line, index) =>
    index === existing ? { ...line, qty: Math.min(line.qty + next.qty, 999) } : line,
  );
}

/**
 * The preview with a promo code in it, the way the server will save it.
 *
 * Mirrors `orders.service.ts`: the code's goods discount joins the agent's typed discount,
 * and its delivery discount comes off the charge. Kept here, pure, so the rule the preview
 * shows is tested without a browser — a preview that added the code to the delivery
 * instead of subtracting it would show a COD the order never asks for.
 */
export function previewWithPromo(input: {
  readonly lines: readonly DeskLine[];
  readonly discountPoisha: string | null;
  readonly deliveryPoisha: string | null;
  readonly promo: {
    readonly discountPoisha: string;
    readonly deliveryDiscountPoisha: string;
  } | null;
}): TotalsPreview {
  if (input.promo === null || input.discountPoisha === null || input.deliveryPoisha === null) {
    return previewTotals(input);
  }
  return previewTotals({
    lines: input.lines,
    discountPoisha: (BigInt(input.discountPoisha) + BigInt(input.promo.discountPoisha)).toString(),
    deliveryPoisha: (
      BigInt(input.deliveryPoisha) - BigInt(input.promo.deliveryDiscountPoisha)
    ).toString(),
  });
}

/** Each line's net as the promo check wants it: price times quantity, in poisha. */
export function promoLines(
  lines: readonly DeskLine[],
): { readonly skuId: string; readonly netPoisha: string }[] {
  return lines.map((line) => ({
    skuId: line.skuId,
    netPoisha: (BigInt(line.unitPricePoisha) * BigInt(line.qty)).toString(),
  }));
}
