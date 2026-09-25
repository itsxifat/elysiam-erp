import { createHash } from 'node:crypto';

import sharp from 'sharp';

/**
 * Image re-encoding: variants, and EXIF removed (architecture §22).
 *
 * §22 asks for thumb, card and full sizes "with EXIF stripped", and the EXIF
 * half is the part that is not about bytes. A photo taken on a phone carries
 * `GPSLatitude`, `GPSLongitude` and a timestamp. A courier's proof-of-delivery
 * photo therefore carries a customer's home coordinates, and a staff member's
 * profile picture carries wherever they took it. Invariant 10 says personal
 * data does not go into code, logs, fixtures or prompts; a public CDN is
 * further out than any of those.
 *
 * `sharp` does not merely *not copy* metadata: by default `toBuffer()` writes
 * only what the encoder needs, so EXIF, XMP, IPTC and any embedded thumbnail
 * are gone unless `withMetadata()` asks for them back. This module never calls
 * it, and `image.test.ts` asserts the absence against a JPEG built with real
 * GPS tags rather than trusting the default to stay put.
 *
 * Re-encoding also removes the other thing an image can carry: `sharp` decodes
 * pixels and encodes new ones, so a polyglot file that is both a valid PNG and
 * a valid script does not survive the round trip.
 */

/** The three sizes §22 names, as the longest edge in pixels. */
export const VARIANT_SIZES = {
  /** Grid and table cells. */
  thumb: 160,
  /** Product cards and the order desk's line items. */
  card: 640,
  /** The largest anything is displayed at. Not "the original". */
  full: 1600,
} as const;

export type VariantName = keyof typeof VARIANT_SIZES;

export interface ImageVariant {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface ProcessedImage {
  readonly variants: Readonly<Record<VariantName, ImageVariant>>;
}

/**
 * How wide the source actually is, without decoding all of it.
 *
 * Read before resizing because `withoutEnlargement` needs something to compare
 * against, and because a "decompression bomb" — a 40 KB PNG that decodes to
 * 30000×30000 — is refused here rather than after it has taken the worker's
 * memory with it.
 */
const MAX_SOURCE_PIXELS = 50_000_000;

export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejected';
  }
}

/**
 * Produce the three variants.
 *
 * Pure with respect to storage: it takes bytes and returns bytes, and the
 * caller decides where they go. That is what makes it testable without a
 * driver, and it is also why the sha256 of each variant is computed here — the
 * hash belongs to the bytes, not to the act of storing them.
 *
 * WebP for every variant, at quality 82. One format rather than "keep the
 * source format" because the alternative means four encoders' worth of
 * behaviour to reason about, and because a PNG photograph is routinely ten
 * times the size of the same image as WebP — on a Bangladeshi mobile
 * connection that is the difference between a catalogue that loads and one
 * that does not. Alpha survives; WebP has it.
 */
export async function processImage(
  source: Uint8Array,
  keyFor: (variant: VariantName, extension: string) => string,
): Promise<ProcessedImage> {
  const metadata = await sharp(source).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width === 0 || height === 0) {
    throw new ImageRejected('This file is not an image we can read.');
  }
  if (width * height > MAX_SOURCE_PIXELS) {
    throw new ImageRejected('This image is too large to process.');
  }

  const variants = {} as Record<VariantName, ImageVariant>;

  for (const [name, edge] of Object.entries(VARIANT_SIZES) as [VariantName, number][]) {
    const { data, info } = await sharp(source)
      /*
       * `rotate()` with no argument applies the EXIF orientation tag and then
       * discards it. It has to happen *because* the metadata is being dropped:
       * a phone photo is often stored sideways with "rotate 90" in EXIF, so
       * stripping EXIF without baking the rotation in turns every portrait
       * photo on its side.
       *
       * **Before `resize`, not after,** and that ordering is the bug the test
       * caught rather than a style choice. sharp applies operations in pipeline
       * order, so a resize that runs first computes its box against the stored
       * dimensions — a 400×200 photo tagged "rotate 90" came out 400 wide and
       * then got turned, producing a variant whose longest edge was the wrong
       * one. `image.test.ts` asserts the dimensions swap.
       */
      .rotate()
      // `fit: 'inside'` keeps the aspect ratio and `withoutEnlargement` means a
      // 100px logo does not become a blurry 1600px one — the `full` variant of
      // a small source is the source's size, which is the honest answer.
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      // No `.withMetadata()`. See the note at the top of this file: that call
      // is what would put the GPS coordinates back.
      .toBuffer({ resolveWithObject: true });

    const bytes = new Uint8Array(data);
    variants[name] = {
      key: keyFor(name, 'webp'),
      width: info.width,
      height: info.height,
      sizeBytes: bytes.byteLength,
      mime: 'image/webp',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
    };
  }

  return { variants };
}

/**
 * Whether an object's bytes are an image we make variants for.
 *
 * Driven by the sniffed MIME type rather than the declared one, for the same
 * reason everything else here is: the declared type is what the client said.
 */
export function isProcessableImage(mime: string): boolean {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(mime);
}
