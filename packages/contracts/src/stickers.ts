import { z } from 'zod';

/**
 * Barcode stickers: the custom size and the extra line (M38a, D-650, D-651).
 *
 * Shared by the server's `POST /v1/catalog/labels` and the console's sticker dialog, so the
 * dialog can never accept a size the server refuses. Whether a size in range can also hold a
 * barcode a scanner reads is `stickerLayout`'s answer (`@elysium/domain/barcode`), checked in
 * both places after these.
 */

/**
 * A custom sticker's size range, in millimetres. Thermal roll printers take labels up to
 * about 4 inches (104 to 108 mm) wide; 110 mm leaves room for the widest, 25 × 15 mm is the
 * smallest die-cut stock sold for them.
 */
export const STICKER_SIZE_LIMITS = {
  widthMm: { min: 25, max: 110 },
  heightMm: { min: 15, max: 100 },
} as const;

/** The longest extra line (D-651): "Made in Bangladesh", a season code. */
export const STICKER_EXTRA_LINE_MAX = 40;

/** At most one decimal: 32.5 is a size, 32.55 is a typing slip. */
function hasOneDecimalAtMost(value: number): boolean {
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-6;
}

function stickerMmSchema(what: 'width' | 'height', min: number, max: number) {
  const range = `A sticker's ${what} is ${String(min)} to ${String(max)} mm.`;
  return z
    .number({ error: `Type the sticker's ${what} in millimetres.` })
    .min(min, range)
    .max(max, range)
    .refine(hasOneDecimalAtMost, `Give the sticker's ${what} to one decimal at most, like 32.5.`);
}

export const stickerWidthMmSchema = stickerMmSchema(
  'width',
  STICKER_SIZE_LIMITS.widthMm.min,
  STICKER_SIZE_LIMITS.widthMm.max,
);

export const stickerHeightMmSchema = stickerMmSchema(
  'height',
  STICKER_SIZE_LIMITS.heightMm.min,
  STICKER_SIZE_LIMITS.heightMm.max,
);

/** A custom sticker's size (D-650). */
export const stickerSizeSchema = z
  .object({ widthMm: stickerWidthMmSchema, heightMm: stickerHeightMmSchema })
  .strict();
export type StickerSize = z.infer<typeof stickerSizeSchema>;

/**
 * The extra line printed on every sticker of one print (D-651): plain text, one line. Blank
 * means none.
 */
export const stickerExtraLineSchema = z
  .string()
  .trim()
  .max(
    STICKER_EXTRA_LINE_MAX,
    `The extra line is at most ${String(STICKER_EXTRA_LINE_MAX)} characters.`,
  )
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'The extra line is one line of text.');
