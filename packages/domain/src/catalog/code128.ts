/**
 * Code 128 (M06: "barcodes (Code128)").
 *
 * A pure encoder: a payload string in, the bar and space widths out. It lives in
 * the domain layer rather than in the PDF template because the thing that can be
 * wrong about a barcode is arithmetic — the check character — and arithmetic is
 * what this package tests.
 *
 * ## Why this is written rather than installed
 *
 * The alternative is a barcode font, and a font cannot be checked: a missing
 * glyph renders as a blank and a wrong check digit renders as a barcode that
 * looks perfect and does not scan. The failure is discovered by a warehouse with
 * a scanner, not by CI. Here the symbol is a list of integers, so a test can
 * assert the check character, the quiet zones and the structure of every
 * pattern, and `code128Modules` is deterministic.
 *
 * ## The encoding, and what is deliberately not supported
 *
 * Subset **B** only, for the printable ASCII range 32-126. That covers every SKU
 * code this system produces (upper-case, digits and `-`, see `sku-code.ts`) with
 * room to spare. Subset C would pack digit pairs into half the width, and it is
 * left out on purpose: switching subsets mid-symbol is where encoders acquire
 * bugs, and a SKU label is 40 mm of an A4 sheet either way. Subset A's control
 * characters have no place in a SKU code at all.
 *
 * Structure: start code, one value per character, the check character, stop.
 * The check character is the start value plus each data value times its
 * 1-based position, modulo 103.
 */

/**
 * The 107 element-width patterns, indexed by code value.
 *
 * Each entry is six digits: bar, space, bar, space, bar, space, in modules, and
 * every one of them sums to 11. The stop pattern (value 106) is the exception —
 * seven elements, 13 modules — because the symbol ends on a bar.
 *
 * Transcribed from the symbology's own table. `code128.test.ts` asserts the
 * structure a transcription error would break: 107 entries, every pattern 11
 * modules except the stop, every pattern distinct, and every pattern starting
 * and ending in the right element type.
 */
const PATTERNS: readonly string[] = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112',
];

/** Subset B's start code. */
const START_B = 104;
const STOP = 106;

/**
 * The quiet zone, in modules, on each side.
 *
 * Ten is the symbology's minimum and it is not decorative: without it a scanner
 * reads the sheet's own hairline as the first bar and rejects the symbol. The
 * commonest reason a printed label does not scan.
 */
export const CODE128_QUIET_MODULES = 10;

export class Code128Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Code128Error';
  }
}

/** The code value of one character in subset B. */
function valueOf(character: string): number {
  const point = character.codePointAt(0) ?? 0;
  if (point < 32 || point > 126) {
    throw new Code128Error(
      'Code 128 subset B encodes printable ASCII only. A barcode payload cannot contain ' +
        'Bangla text, accents or control characters.',
    );
  }
  return point - 32;
}

/** The check character's code value, exposed so a test can assert it directly. */
export function code128CheckValue(payload: string): number {
  let sum = START_B;
  let position = 1;
  for (const character of payload) {
    sum += valueOf(character) * position;
    position += 1;
  }
  return sum % 103;
}

export interface Code128Symbol {
  /**
   * Element widths in modules, starting with a bar and alternating.
   *
   * Quiet zones are *not* included: they are whitespace, and a renderer that
   * gets them as a zero-width "bar" has to special-case them. Use
   * `CODE128_QUIET_MODULES` when laying the symbol out.
   */
  readonly modules: readonly number[];
  /** Total width in modules, excluding the quiet zones. */
  readonly width: number;
  readonly payload: string;
  readonly checkValue: number;
}

export function code128Encode(payload: string): Code128Symbol {
  if (payload === '') throw new Code128Error('A barcode needs a payload.');
  // 48 characters is roughly 400 modules, already wider than a 40 mm label at a
  // scannable module width. A longer payload is a mistake upstream, not a label.
  if (payload.length > 48) {
    throw new Code128Error(
      `A Code 128 payload of ${String(payload.length)} characters is too long to print.`,
    );
  }

  const values = [START_B, ...[...payload].map(valueOf), code128CheckValue(payload), STOP];
  const modules: number[] = [];
  for (const value of values) {
    const pattern = PATTERNS[value];
    if (pattern === undefined) throw new Code128Error('No Code 128 pattern for that value.');
    for (const digit of pattern) modules.push(Number(digit));
  }

  return {
    modules,
    width: modules.reduce((total, module) => total + module, 0),
    payload,
    checkValue: code128CheckValue(payload),
  };
}

/**
 * The symbol as SVG `<rect>` elements, in a viewBox of module units.
 *
 * Module units rather than millimetres, so the caller scales it with CSS and the
 * bars stay integral. A barcode scaled by a fractional module width is the other
 * common reason a printed symbol fails: the renderer rounds each bar
 * independently and the ratios drift.
 */
export function code128Svg(payload: string, heightModules = 40): string {
  const symbol = code128Encode(payload);
  const total = symbol.width + CODE128_QUIET_MODULES * 2;

  let x = CODE128_QUIET_MODULES;
  const rects: string[] = [];
  symbol.modules.forEach((width, index) => {
    // Even indexes are bars, odd are spaces: the pattern table alternates.
    if (index % 2 === 0) {
      rects.push(
        `<rect x="${String(x)}" y="0" width="${String(width)}" height="${String(heightModules)}"/>`,
      );
    }
    x += width;
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(total)} ${String(heightModules)}" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges" fill="currentColor" ` +
    `role="img" aria-label="${payload}">${rects.join('')}</svg>`
  );
}

/** The patterns, for the structural test. Not part of the encoder's interface. */
export const CODE128_PATTERNS = PATTERNS;
