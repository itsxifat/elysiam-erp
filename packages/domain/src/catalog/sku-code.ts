/**
 * SKU codes (architecture §8, M06).
 *
 * §8 gives `{ORG}-{CAT}-{SEQ4}-{COLOR}-{SIZE}` as an example rather than a
 * specification, so the separator, the segment widths and the normalisation are
 * decided here and recorded as D-119. Everything in this file is pure: the same
 * product, category and variant produce the same code in the API, in a CSV
 * import preview and in a test, which is what lets the preview a user approves
 * be the code that is written.
 *
 * ## Why the shape matters beyond looking tidy
 *
 * A SKU code is printed on a label, read by a scanner, typed into a POS by a
 * cashier and pasted into a courier's sheet. Three properties follow, and each
 * is enforced below rather than assumed:
 *
 * 1. **One character set.** Upper-case A-Z, 0-9 and the `-` separator, nothing
 *    else. A Bangla product name is correct in the catalogue and wrong in a
 *    Code 128 payload, and a lower-case `l` beside a `1` in a hand-typed code
 *    is a mis-picked parcel.
 * 2. **Segments never collide.** The separator cannot appear inside a segment,
 *    so `ELY-SHRT-0001-RED-M` parses back into its parts unambiguously. A
 *    category code containing a dash would make `{CAT}` and `{SEQ}` unreadable.
 * 3. **The sequence is per org and zero-padded, not globally unique.** Five
 *    brands share one database (D-002); `ELY-…-0001` and `OUR-…-0001` are two
 *    different products and both are correct. Uniqueness is therefore composite
 *    in the database, and the padding is presentational only — the 10,000th
 *    product simply becomes five digits rather than failing.
 */

/** The separator between segments. Never allowed inside one (D-119). */
export const SKU_SEPARATOR = '-';

/** The zero-padded width of the sequence segment. Grows past it rather than wrapping. */
export const SKU_SEQUENCE_WIDTH = 4;

/** How long one variant segment (colour, size, a custom axis) may be. */
export const SKU_SEGMENT_MAX = 8;

/** The longest code the database column and the Code 128 label both accept. */
export const SKU_CODE_MAX = 64;

export class SkuCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkuCodeError';
  }
}

/**
 * Fold arbitrary text into a SKU segment.
 *
 * Accents and non-Latin scripts are dropped rather than transliterated: a
 * guessed transliteration of `লাল` is a code nobody can predict, and an
 * unpredictable code is one a user cannot search for. When nothing survives the
 * fold the caller has to supply a code explicitly, which is why this throws
 * instead of returning an empty segment — an empty segment would produce
 * `ELY-SHRT-0001--M`, two separators in a row, and break property 2 above.
 */
export function skuSegment(raw: string, what: string): string {
  const folded = raw
    .normalize('NFKD')
    // Strip combining marks left behind by the decomposition, so `é` becomes `E`.
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');

  if (folded === '') {
    throw new SkuCodeError(
      `${what} has no letters or digits a SKU code can use. Give it a short code such as "RED".`,
    );
  }
  return folded.slice(0, SKU_SEGMENT_MAX);
}

export interface SkuCodeParts {
  /** The org's short code, e.g. `ELY`. */
  readonly orgCode: string;
  /** The category's short code, e.g. `SHRT`. Optional: an uncategorised product. */
  readonly categoryCode?: string | undefined;
  /** The product's per-org sequence number, 1-based. */
  readonly sequence: number;
  /**
   * The variant segments, in the attribute order the product's matrix declares.
   * Empty for a product with a single, unvaried SKU.
   */
  readonly variantCodes: readonly string[];
}

/**
 * Build one SKU code.
 *
 * The variant segments arrive in **matrix order**, not sorted and not in the
 * order the caller happened to iterate a map. Order is part of the code — swap
 * colour and size and `ELY-SHRT-0001-RED-M` becomes a different string for the
 * same variant — so the caller that owns the attribute order passes it, and
 * this function never reorders.
 */
export function buildSkuCode(parts: SkuCodeParts): string {
  if (!Number.isInteger(parts.sequence) || parts.sequence < 1) {
    throw new SkuCodeError('A SKU sequence is a whole number from 1.');
  }

  const segments = [
    skuSegment(parts.orgCode, 'The organization code'),
    ...(parts.categoryCode === undefined || parts.categoryCode === ''
      ? []
      : [skuSegment(parts.categoryCode, 'The category code')]),
    String(parts.sequence).padStart(SKU_SEQUENCE_WIDTH, '0'),
    ...parts.variantCodes.map((code, index) => skuSegment(code, `Variant segment ${index + 1}`)),
  ];

  const code = segments.join(SKU_SEPARATOR);
  if (code.length > SKU_CODE_MAX) {
    throw new SkuCodeError(
      `That SKU code would be ${String(code.length)} characters; the limit is ${String(SKU_CODE_MAX)}. Shorten the category or variant codes.`,
    );
  }
  return code;
}

const SKU_CODE_SHAPE = new RegExp(`^[A-Z0-9]+(-[A-Z0-9]+)*$`);

/** Is this a code this system could have produced? Used when a CSV supplies one. */
export function isSkuCode(value: string): boolean {
  return value.length > 0 && value.length <= SKU_CODE_MAX && SKU_CODE_SHAPE.test(value);
}

/**
 * A product's parent SKU (D-661): its SKU codes without the variant segments, the org code,
 * the category code (none for an uncategorised product) and the zero-padded sequence:
 * `ELY-HAWA-0020`, whose variants are `ELY-HAWA-0020-M`, `ELY-HAWA-0020-L`. It names the
 * product, so two products may share a name; the sequence is unique per brand, so the parent
 * SKU is too.
 */
export function parentSkuCode(parts: {
  readonly orgCode: string;
  readonly categoryCode?: string | undefined;
  readonly sequence: number;
}): string {
  return buildSkuCode({ ...parts, variantCodes: [] });
}

/**
 * A new product's web address (D-661): its parent SKU in lower case (`ely-hawa-0020`). The
 * catalog's slug shape by construction: a SKU code is A-Z, 0-9 and single dashes.
 */
export function parentSkuSlug(parentSku: string): string {
  return parentSku.toLowerCase();
}

/**
 * An existing product's parent SKU (D-661), as the product page and the list show it.
 *
 * Read back from one of its SKU codes when one was built by this system (`skuCodePrefix`): a
 * product keeps the prefix its labels carry when it moves category (D-623). A product with no
 * SKU yet (a draft) takes the prefix it would get now. A product whose codes were imported as
 * they were (M14a's opening data) has none: `null`, never a made-up one its labels disagree with.
 */
export function productParentSku(input: {
  readonly sequence: number;
  /** The product's SKU codes, in any order; empty for a product with none. */
  readonly skuCodes: readonly string[];
  /** The brand's org code now, for a product with no SKU yet. */
  readonly orgCode: string | undefined;
  /** The product's category code now, for a product with no SKU yet. */
  readonly categoryCode: string | undefined;
}): string | null {
  try {
    for (const code of input.skuCodes) {
      const prefix = skuCodePrefix(code, input.sequence);
      if (prefix !== undefined) {
        return parentSkuCode({
          orgCode: prefix.orgCode,
          categoryCode: prefix.categoryCode,
          sequence: input.sequence,
        });
      }
    }
    if (input.skuCodes.length > 0 || input.orgCode === undefined) return null;
    return parentSkuCode({
      orgCode: input.orgCode,
      categoryCode: input.categoryCode,
      sequence: input.sequence,
    });
  } catch (error) {
    if (error instanceof SkuCodeError) return null;
    throw error;
  }
}

/**
 * The organization and category segments a product's SKU codes already carry (M39a, D-623).
 *
 * A product keeps its codes when it moves to another category (they are printed), so a
 * variant added afterwards would otherwise start with the new category's segment and the
 * product's labels would read two ways. `extendMatrix` reads the prefix back from one of the
 * product's existing codes and builds the new ones with it. Undefined when the code is not
 * one this system built for that sequence (an imported code): the caller then uses the
 * product's current category, as before.
 */
export function skuCodePrefix(
  code: string,
  sequence: number,
): { readonly orgCode: string; readonly categoryCode: string | undefined } | undefined {
  if (!Number.isInteger(sequence) || sequence < 1) return undefined;
  const parts = code.split(SKU_SEPARATOR);
  const seq = String(sequence).padStart(SKU_SEQUENCE_WIDTH, '0');
  const orgCode = parts[0];
  if (orgCode === undefined || orgCode === '') return undefined;
  // The category reading first: `ELY-0007-0007-M` is category 0007's product 7. The other
  // reading needs a first variant code equal to the padded sequence, which nobody types.
  if (parts[2] === seq && parts[1] !== undefined && parts[1] !== '') {
    return { orgCode, categoryCode: parts[1] };
  }
  if (parts[1] === seq) return { orgCode, categoryCode: undefined };
  return undefined;
}
