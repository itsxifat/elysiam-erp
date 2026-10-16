import type { MonoBitmap } from './raster.js';

/**
 * The three label-printer languages a page is sent in over raw TCP 9100 (M46, D-810, D-811).
 * Each prints the page as one bitmap, so what comes out is exactly the page the PDF shows —
 * the same HTML, fonts and Bangla shaping by Chromium — rather than the printer's built-in
 * fonts, which draw no Bangla. Written from each language's programming manual:
 *
 * - **TSPL / TSPL2** (TSC, and the Xprinter, Gprinter and HPRT label printers that speak it):
 *   `SIZE`, `GAP`, `DIRECTION`, `REFERENCE`, `CLS`, `BITMAP x,y,widthBytes,height,mode,data`
 *   and `PRINT sets,copies`. In `BITMAP` a 0 bit prints a dot and a 1 leaves it white, the
 *   opposite of the other two, so the rows are inverted.
 * - **ZPL II** (Zebra): `^XA`, `^PW` print width, `^LL` label length, `^LH0,0`, `^FO0,0`, the
 *   graphic as `^GFA,total,total,bytesPerRow,<hex>`, `^PQ` copies, `^XZ`. A 1 bit is black.
 * - **ESC/POS** raster (Epson, and the receipt-style 58 / 80 mm printers): `ESC @`, then the
 *   image as `GS v 0 m xL xH yL yH d…` in bands of at most 255 rows (some printers take no
 *   taller block), a feed and a cut. A 1 bit is black.
 *
 * Untested on real hardware: the byte layouts are pinned by tests against these manuals.
 */

const ascii = (text: string) => Buffer.from(text, 'latin1');

/** Millimetres for a TSPL command: at most one decimal, never an exponent. */
function mm(micrometres: number): string {
  const value = Math.round(micrometres / 100) / 10;
  return String(value);
}

export interface PageCommandOptions {
  readonly widthUm: number;
  readonly heightUm: number;
  readonly copies: number;
}

/** A TSPL job: one label, `copies` times. Die-cut labels with a 2 mm gap (D-810). */
export function tsplJob(bitmap: MonoBitmap, options: PageCommandOptions): Uint8Array {
  const inverted = Buffer.from(bitmap.rows);
  for (let index = 0; index < inverted.length; index += 1) {
    inverted[index] = ~(inverted[index] ?? 0) & 0xff;
  }
  return new Uint8Array(
    Buffer.concat([
      ascii(
        [
          `SIZE ${mm(options.widthUm)} mm,${mm(options.heightUm)} mm`,
          'GAP 2 mm,0 mm',
          'DIRECTION 1',
          'REFERENCE 0,0',
          'CLS',
          `BITMAP 0,0,${String(bitmap.widthBytes)},${String(bitmap.heightDots)},0,`,
        ].join('\r\n'),
      ),
      inverted,
      ascii(`\r\nPRINT 1,${String(options.copies)}\r\n`),
    ]),
  );
}

/** A ZPL job: the page as one graphic field, `copies` times. */
export function zplJob(bitmap: MonoBitmap, options: { readonly copies: number }): Uint8Array {
  const total = bitmap.rows.length;
  const hex = Buffer.from(bitmap.rows).toString('hex').toUpperCase();
  return new Uint8Array(
    ascii(
      [
        '^XA',
        `^PW${String(bitmap.widthDots)}`,
        `^LL${String(bitmap.heightDots)}`,
        '^LH0,0',
        `^FO0,0^GFA,${String(total)},${String(total)},${String(bitmap.widthBytes)},${hex}^FS`,
        `^PQ${String(options.copies)}`,
        '^XZ',
        '',
      ].join('\n'),
    ),
  );
}

/** The most rows one ESC/POS raster block carries. */
export const ESCPOS_BAND_ROWS = 255;

/** An ESC/POS job: the page in bands, then a feed and a partial cut, `copies` times. */
export function escposJob(bitmap: MonoBitmap, options: { readonly copies: number }): Uint8Array {
  const parts: Buffer[] = [];
  for (let copy = 0; copy < options.copies; copy += 1) {
    parts.push(Buffer.from([0x1b, 0x40]));
    for (let top = 0; top < bitmap.heightDots; top += ESCPOS_BAND_ROWS) {
      const rows = Math.min(ESCPOS_BAND_ROWS, bitmap.heightDots - top);
      parts.push(
        Buffer.from([
          0x1d,
          0x76,
          0x30,
          0x00,
          bitmap.widthBytes & 0xff,
          (bitmap.widthBytes >> 8) & 0xff,
          rows & 0xff,
          (rows >> 8) & 0xff,
        ]),
        Buffer.from(
          bitmap.rows.buffer,
          bitmap.rows.byteOffset + top * bitmap.widthBytes,
          rows * bitmap.widthBytes,
        ),
      );
    }
    // ESC d 4: feed four lines past the tear bar; GS V 66 0: feed and cut (partial).
    parts.push(Buffer.from([0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]));
  }
  return new Uint8Array(Buffer.concat(parts));
}
