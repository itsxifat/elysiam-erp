/**
 * EAN-13 (M38a, D-603).
 *
 * Every SKU gets a barcode a scanner can read off a 38 mm sticker. The SKU code in Code 128
 * (`code128.ts`) is the wrong symbol for that: `ELY-PNJ-0042-XL-RED` is nineteen characters,
 * about 230 modules, and on a 38 mm sticker that is a module narrower than a thermal printer's
 * dot. EAN-13 is 95 modules whatever the number, every retail scanner reads it, and its check
 * digit catches every single-digit misread.
 *
 * ## The ERP's own numbers
 *
 * GS1 reserves the prefix `2` for numbers a business assigns itself for use inside its own
 * stores ("restricted circulation"); they are never allocated to a manufacturer, so one of
 * ours can never collide with a supplier's real barcode on another product. An internal
 * number is `2`, then an 11-digit per-brand sequence, then the check digit:
 *
 *     2 00000000042 C   (the 42nd barcode this brand handed out)
 *
 * The sequence comes from an atomic per-brand counter (`catalog.sku_settings`), so this
 * module only does the arithmetic: the check digit, the validity test, the bars.
 *
 * ## Why the bars are integers
 *
 * Like `code128Svg`: the SVG's viewBox is in modules, every bar is a whole number of them,
 * and the caller scales the whole symbol with CSS. A renderer rounding each bar separately
 * is the other common reason a printed symbol does not scan.
 */

export class Ean13Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Ean13Error';
  }
}

/** The GS1 prefix for numbers a business assigns for its own use. */
export const EAN13_INTERNAL_PREFIX = '2';

/** The largest per-brand sequence an internal EAN-13 can carry: eleven digits. */
export const EAN13_MAX_SEQUENCE = 99_999_999_999;

/** Modules of quiet zone the symbology asks for on each side. */
export const EAN13_QUIET_LEFT = 11;
export const EAN13_QUIET_RIGHT = 7;
/** The symbol's own width, guards included, quiet zones excluded. */
export const EAN13_MODULES = 95;

const DIGITS = /^\d+$/;

/**
 * The check digit of twelve digits.
 *
 * Weights 1 and 3 alternately from the left; the check digit brings the sum to a multiple
 * of ten. Because 3 is coprime with 10, a single wrong digit anywhere always changes the sum
 * mod 10, which is why a misread digit is caught rather than scanned as another product.
 */
export function ean13CheckDigit(first12: string): number {
  if (first12.length !== 12 || !DIGITS.test(first12)) {
    throw new Ean13Error('An EAN-13 check digit is computed from exactly twelve digits.');
  }
  let total = 0;
  for (let index = 0; index < 12; index += 1) {
    const digit = first12.charCodeAt(index) - 48;
    total += index % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (total % 10)) % 10;
}

/** Thirteen digits whose last is the check digit of the first twelve. */
export function isValidEan13(code: string): boolean {
  if (code.length !== 13 || !DIGITS.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === code.charCodeAt(12) - 48;
}

/** A valid EAN-13 in the ERP's own range: the ones it hands out itself (D-603). */
export function isInternalEan13(code: string): boolean {
  return isValidEan13(code) && code.startsWith(EAN13_INTERNAL_PREFIX);
}

/** The internal EAN-13 for a per-brand sequence: `2`, eleven digits, the check digit. */
export function internalEan13(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > EAN13_MAX_SEQUENCE) {
    throw new Ean13Error(
      `An internal barcode sequence is a whole number from 1 to ${String(EAN13_MAX_SEQUENCE)}.`,
    );
  }
  const first12 = `${EAN13_INTERNAL_PREFIX}${String(sequence).padStart(11, '0')}`;
  return `${first12}${String(ean13CheckDigit(first12))}`;
}

/** The sequence an internal EAN-13 carries, or null for any other code. */
export function internalEan13Sequence(code: string): number | null {
  return isInternalEan13(code) ? Number(code.slice(1, 12)) : null;
}

/*
 * The three digit-pattern sets, seven modules each, `1` a bar. Transcribed from the
 * symbology's table; `barcode.test.ts` decodes every encoded symbol back to its digits, which
 * a transcription error in any one of the thirty patterns would break.
 */
const L_CODES = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
] as const;
const G_CODES = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
] as const;
const R_CODES = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
] as const;

/**
 * The first digit is not drawn as bars: it is carried by which of the left six digits use
 * the L set and which the G set. Index = first digit.
 */
const PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
] as const;

const START = '101';
const CENTRE = '01010';
const END = '101';

/** The digit patterns, for the round-trip test. Not part of the encoder's interface. */
export const EAN13_PATTERNS = { L: L_CODES, G: G_CODES, R: R_CODES, PARITY } as const;

/**
 * The symbol as 95 modules, `'1'` a bar and `'0'` a space, guards included.
 *
 * Refuses a code with a wrong check digit rather than drawing it: a symbol that looks
 * perfect and does not scan is found by a packer with a parcel, not by CI.
 */
export function ean13Modules(code: string): string {
  if (!isValidEan13(code)) {
    throw new Ean13Error(`"${code}" is not a valid EAN-13: thirteen digits and a check digit.`);
  }
  const digits = [...code].map((character) => character.charCodeAt(0) - 48);
  const parity = PARITY[digits[0] ?? 0] ?? PARITY[0];
  let left = '';
  for (let index = 1; index <= 6; index += 1) {
    const digit = digits[index] ?? 0;
    left += parity[index - 1] === 'L' ? L_CODES[digit] : G_CODES[digit];
  }
  let right = '';
  for (let index = 7; index <= 12; index += 1) right += R_CODES[digits[index] ?? 0];
  return `${START}${left}${CENTRE}${right}${END}`;
}

/** Whether module `index` (0-based, of 95) belongs to a guard: those bars are drawn longer. */
function isGuard(index: number): boolean {
  return index < 3 || (index >= 45 && index < 50) || index >= 92;
}

export interface Ean13SvgOptions {
  /** The data bars' height in modules. Guard bars run 5 modules further. Default 50. */
  readonly barHeight?: number;
  /** Print the thirteen digits under the bars. Default true. */
  readonly showDigits?: boolean;
  /** The font for the digits; the renderer's default when absent. */
  readonly fontFamily?: string;
}

/**
 * The symbol as SVG, in a viewBox of modules: quiet zones, bars, longer guard bars and the
 * human-readable digits in the standard places (the first digit left of the start guard,
 * six under each half).
 *
 * The viewBox keeps its aspect ratio (no `preserveAspectRatio="none"`), so a caller sizing
 * it by width gets digits that are not stretched; the bars are still whole modules.
 */
export function ean13Svg(code: string, options: Ean13SvgOptions = {}): string {
  const modules = ean13Modules(code);
  const barHeight = Math.max(10, Math.round(options.barHeight ?? 50));
  const showDigits = options.showDigits ?? true;
  const guardExtra = showDigits ? 5 : 0;
  const fontSize = 9;
  const width = EAN13_QUIET_LEFT + EAN13_MODULES + EAN13_QUIET_RIGHT;
  const height = barHeight + (showDigits ? fontSize + 1 : 0);

  const rects: string[] = [];
  let index = 0;
  while (index < modules.length) {
    if (modules[index] !== '1') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < modules.length && modules[end] === '1') end += 1;
    // A run of bars never mixes a guard and a data bar: every L and G pattern starts with
    // a space and ends with a bar, every R pattern starts with a bar and ends with a space,
    // and the guards sit between them.
    const tall = isGuard(index);
    rects.push(
      `<rect x="${String(EAN13_QUIET_LEFT + index)}" y="0" width="${String(end - index)}" ` +
        `height="${String(tall ? barHeight + guardExtra : barHeight)}"/>`,
    );
    index = end;
  }

  const text: string[] = [];
  if (showDigits) {
    const baseline = barHeight + fontSize;
    const font = options.fontFamily === undefined ? '' : ` font-family="${options.fontFamily}"`;
    const at = (x: number, digit: string) =>
      `<text x="${String(x)}" y="${String(baseline)}" font-size="${String(fontSize)}"${font} ` +
      `text-anchor="middle">${digit}</text>`;
    text.push(at(EAN13_QUIET_LEFT - 5, code.charAt(0)));
    for (let digit = 0; digit < 6; digit += 1) {
      text.push(at(EAN13_QUIET_LEFT + 3 + digit * 7 + 3.5, code.charAt(1 + digit)));
      text.push(at(EAN13_QUIET_LEFT + 50 + digit * 7 + 3.5, code.charAt(7 + digit)));
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" ` +
    `shape-rendering="crispEdges" fill="currentColor" role="img" aria-label="${code}">` +
    `${rects.join('')}${text.join('')}</svg>`
  );
}

/** The symbol's full width in modules, quiet zones included: what a caller sizes by. */
export const EAN13_TOTAL_MODULES = EAN13_QUIET_LEFT + EAN13_MODULES + EAN13_QUIET_RIGHT;
