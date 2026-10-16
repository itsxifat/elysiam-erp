import type { DecodedImage } from './png.js';

/**
 * A page as a thermal printer's dots (M46, D-811): one bit a dot, eight dots a byte, the
 * leftmost dot the byte's highest bit, `1` for black. Each driver turns this into its own
 * language (TSPL inverts it).
 */
export interface MonoBitmap {
  /** Dots across; a whole number of bytes (`widthBytes × 8`). */
  readonly widthDots: number;
  readonly widthBytes: number;
  readonly heightDots: number;
  /** `heightDots` rows of `widthBytes` bytes. */
  readonly rows: Uint8Array;
}

/**
 * Below this brightness (0 black to 255 white) a dot is printed. The page is black ink on
 * white already (M43, D-752: nothing grey), so the threshold only decides the antialiased
 * edges of type; halfway keeps strokes their drawn weight.
 */
export const BLACK_BELOW = 128;

/**
 * The image as dots: composited on white, luma by Rec. 601, thresholded, and cut or padded
 * (white) to exactly `widthDots × heightDots`, the printer's paper.
 */
export function toMonochrome(
  image: DecodedImage,
  size: { readonly widthDots: number; readonly heightDots: number },
  threshold = BLACK_BELOW,
): MonoBitmap {
  const widthBytes = Math.ceil(size.widthDots / 8);
  const rows = new Uint8Array(widthBytes * size.heightDots);
  const { channels, data } = image;
  const height = Math.min(image.height, size.heightDots);
  const width = Math.min(image.width, size.widthDots);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * image.width + x) * channels;
      let luma: number;
      let alpha = 255;
      if (channels === 1 || channels === 2) {
        luma = data[at] ?? 255;
        if (channels === 2) alpha = data[at + 1] ?? 255;
      } else {
        const r = data[at] ?? 255;
        const g = data[at + 1] ?? 255;
        const b = data[at + 2] ?? 255;
        luma = (299 * r + 587 * g + 114 * b) / 1000;
        if (channels === 4) alpha = data[at + 3] ?? 255;
      }
      // Over white paper: a transparent dot is paper.
      const shown = (luma * alpha + 255 * (255 - alpha)) / 255;
      if (shown < threshold) {
        const index = y * widthBytes + (x >> 3);
        rows[index] = (rows[index] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return { widthDots: widthBytes * 8, widthBytes, heightDots: size.heightDots, rows };
}

/** Dots along a length: millimetres at a printer's dots per inch, rounded to a whole dot. */
export function dotsFor(micrometres: number, dpi: number): number {
  return Math.round((micrometres / 25_400) * dpi);
}
