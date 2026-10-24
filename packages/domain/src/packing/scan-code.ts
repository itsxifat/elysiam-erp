import { LOT_COUNT_MAX, parseLotCode } from './lots.js';

/**
 * The digits-only code an order's barcodes carry (D-912).
 *
 * The owner: the brand's letters in front of the order number (`ELY-2610-00042`) printed hazy
 * and the scanners missed them. Code 128 draws a letter or a hyphen as a symbol of its own but
 * two digits as one (subset C), so a code of digits alone is about half as long and its bars
 * can be twice as wide on the same label. The code drops what a brand's own ERP does not need
 * to tell orders apart (the prefix: one brand a database, D-470; the hyphens) and keeps the rest:
 *
 * - an order, ten digits: its `YYMM` and its counter to six digits, `ELY-2610-00042` →
 *   `2610000042`;
 * - one lot of several, twelve: the order's ten and the lot to two, lot 2 → `261000004202`.
 *
 * Fixed lengths, both even (subset C pairs every digit), and never the same length as each
 * other, so a code reads back to one order and at most one lot. An order whose counter passed
 * six digits (a million orders in a month) has no digits-only code and its barcode carries the
 * order number as before. The order number in letters stays the human copy beside the bars, and
 * a code printed before this (the order number, `…-L2`) still scans.
 */

/** An order's digits-only code: `YYMM` and the counter to six digits. */
export const ORDER_SCAN_DIGITS = 10;
/** One lot's digits-only code: the order's ten and the lot to two. */
export const LOT_SCAN_DIGITS = 12;

const ORDER_NO = /^[A-Z][A-Z0-9]{1,5}-(\d{4})-(\d{5,})$/;
const ORDER_SCAN = /^(\d{4})(\d{6})$/;
const LOT_SCAN = /^(\d{10})(\d{2})$/;

/** The ten digits for an order number, or null when it has none (see above). */
export function orderScanCode(orderNo: string): string | null {
  const match = ORDER_NO.exec(orderNo.trim().toUpperCase());
  if (match === null) return null;
  const [, period = '', counter = ''] = match;
  const sequence = Number(counter);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) return null;
  return `${period}${String(sequence).padStart(6, '0')}`;
}

/** The twelve digits for one lot of an order, or null when the order has no digits-only code. */
export function lotScanCode(orderNo: string, lot: number): string | null {
  if (!Number.isInteger(lot) || lot < 1 || lot > LOT_COUNT_MAX) {
    throw new RangeError(`A lot is 1 to ${String(LOT_COUNT_MAX)}.`);
  }
  const order = orderScanCode(orderNo);
  return order === null ? null : `${order}${String(lot).padStart(2, '0')}`;
}

/**
 * The period and counter ten scanned digits name, as the order number writes them (the counter
 * to five digits, wider past them), or null for anything else. A month outside 01 to 12 or a
 * counter of zero is no order's code.
 */
export function parseOrderScanCode(
  code: string,
): { readonly period: string; readonly counter: string } | null {
  const match = ORDER_SCAN.exec(code.trim());
  if (match === null) return null;
  const [, period = '', digits = ''] = match;
  const month = Number(period.slice(2));
  const sequence = Number(digits);
  if (month < 1 || month > 12 || sequence < 1) return null;
  return { period, counter: String(sequence).padStart(5, '0') };
}

/** The order's ten digits and the lot twelve scanned digits name, or null for anything else. */
export function parseLotScanCode(
  code: string,
): { readonly orderCode: string; readonly lot: number } | null {
  const match = LOT_SCAN.exec(code.trim());
  if (match === null) return null;
  const [, orderCode = '', digits = ''] = match;
  const lot = Number(digits);
  if (lot < 1 || lot > LOT_COUNT_MAX || parseOrderScanCode(orderCode) === null) return null;
  return { orderCode, lot };
}

/**
 * The order code and lot of a scanned lot code in either form, the order number's (`…-L2`) or
 * the twelve digits, or null for any other code. What the packing station and the handover read.
 */
export function readLotCode(
  code: string,
): { readonly orderCode: string; readonly lot: number } | null {
  return parseLotCode(code) ?? parseLotScanCode(code);
}

/**
 * The period and counter of the order a search box's text names when a scanner typed it there
 * (D-912): an order's ten digits, a lot's twelve, or a lot's code in letters (`…-L2`). Null for
 * any other text, an order number included, which a search's own match on the order number
 * already finds. A search lists every order numbered `<any prefix>-<period>-<counter>`.
 */
export function scannedOrderParts(
  text: string,
): { readonly period: string; readonly counter: string } | null {
  const lot = readLotCode(text);
  const code = lot?.orderCode ?? text;
  const digits = parseOrderScanCode(code);
  if (digits !== null || lot === null) return digits;
  const match = ORDER_NO.exec(code.trim().toUpperCase());
  if (match === null) return null;
  const [, period = '', counter = ''] = match;
  return { period, counter };
}
