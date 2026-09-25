import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { isProcessableImage, processImage, VARIANT_SIZES } from './image.js';

/**
 * The image job (architecture §22, invariant 10).
 *
 * The assertion that matters here is the EXIF one, and it is asserted against
 * a JPEG that really carries GPS coordinates rather than against the claim that
 * sharp drops metadata by default. The default is the mechanism; the test is
 * the guarantee. If a later change adds `.withMetadata()` for some innocent
 * reason — keeping the colour profile, say — this fails, and that is the whole
 * point: a courier's proof-of-delivery photo carries the customer's home
 * coordinates, and nothing else in the system would notice them going out.
 */

/** A source image with GPS tags, a colour profile and an orientation. */
async function photoWithGps(width = 1200, height = 800): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .withExif({
      IFD0: { Make: 'Elysium', Model: 'Test Camera', Copyright: 'nobody' },
      /*
       * GPS tags live in IFD3, not in a directory called `GPS`.
       *
       * That is libvips' numbering — ifd0 is the main image, ifd1 the
       * thumbnail, ifd2 the EXIF sub-IFD and ifd3 the GPS IFD — and sharp's
       * `Exif` type names only those four. Writing them under `GPS` is a type
       * error and, worse, would have written nothing: the fixture would have
       * carried no coordinates and the assertion below would have passed
       * against an image that never had any.
       *
       * Dhaka, as a rational triple, because stripping `'0'` proves nothing
       * about stripping what a phone actually writes.
       */
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '23/1 48/1 2652/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '90/1 24/1 1116/100',
      },
    })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

const keyFor = (variant: string, extension: string): string =>
  `public/org/2026/03/abc.${variant}.${extension}`;

describe('EXIF stripping', () => {
  it('starts from a source that genuinely carries GPS, or the test proves nothing', async () => {
    const metadata = await sharp(await photoWithGps()).metadata();
    expect(metadata.exif).toBeDefined();
    expect(metadata.exif?.toString('latin1')).toContain('Elysium');
  });

  it('produces variants with no EXIF at all', async () => {
    const processed = await processImage(await photoWithGps(), keyFor);

    for (const [name, variant] of Object.entries(processed.variants)) {
      const metadata = await sharp(variant.bytes).metadata();
      expect(metadata.exif, `${name} kept an EXIF block`).toBeUndefined();

      // Belt and braces: the raw bytes must not contain the camera make
      // either. A metadata reader that silently ignores a malformed block
      // would let a byte-level leak past the check above.
      const raw = Buffer.from(variant.bytes).toString('latin1');
      expect(raw).not.toContain('Elysium');
      expect(raw).not.toContain('GPSLatitude');
    }
  });
});

describe('variants', () => {
  it('makes exactly thumb, card and full, all WebP', async () => {
    const processed = await processImage(await photoWithGps(), keyFor);
    expect(Object.keys(processed.variants).sort()).toEqual(['card', 'full', 'thumb']);
    for (const variant of Object.values(processed.variants)) {
      expect(variant.mime).toBe('image/webp');
      expect(variant.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(variant.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('bounds each variant by its longest edge and keeps the aspect ratio', async () => {
    const processed = await processImage(await photoWithGps(1200, 800), keyFor);

    for (const [name, variant] of Object.entries(processed.variants)) {
      const edge = VARIANT_SIZES[name as keyof typeof VARIANT_SIZES];
      expect(Math.max(variant.width, variant.height)).toBeLessThanOrEqual(edge);
      expect(variant.width / variant.height).toBeCloseTo(1200 / 800, 1);
    }
  });

  /*
   * `withoutEnlargement`. A 100px logo upscaled to 1600px is a blurry lie
   * about what was uploaded, and it costs bandwidth to tell it.
   */
  it('never enlarges a small source', async () => {
    const processed = await processImage(await photoWithGps(100, 80), keyFor);
    expect(processed.variants.full.width).toBe(100);
    expect(processed.variants.thumb.width).toBeLessThanOrEqual(100);
  });

  /*
   * A phone photo is often stored sideways with "rotate 90" in EXIF. Dropping
   * the metadata without baking the rotation in turns every portrait photo on
   * its side — the bug `.rotate()` exists to prevent, and one that is invisible
   * unless something asserts the dimensions swapped.
   */
  it('applies the EXIF orientation before discarding it', async () => {
    const sideways = new Uint8Array(
      await sharp({ create: { width: 400, height: 200, channels: 3, background: '#123456' } })
        /*
         * `withMetadata({ orientation })`, not `withExif({ IFD0: { Orientation } })`.
         * The second one writes the tag and sharp reads it back as 1 — verified
         * against sharp 0.35.4 — so a fixture built that way is not sideways at
         * all and the test passes against nothing.
         *
         * 6 = rotate 90° clockwise on display.
         */
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer(),
    );

    const processed = await processImage(sideways, keyFor);
    expect(processed.variants.full.width).toBe(200);
    expect(processed.variants.full.height).toBe(400);
  });

  it('refuses bytes that are not an image', async () => {
    await expect(processImage(new TextEncoder().encode('not an image'), keyFor)).rejects.toThrow();
  });

  it('keys each variant beside the original', async () => {
    const processed = await processImage(await photoWithGps(), keyFor);
    expect(processed.variants.thumb.key).toBe('public/org/2026/03/abc.thumb.webp');
  });
});

describe('which files get variants', () => {
  it('covers the image types the allow-list admits, and nothing else', () => {
    expect(isProcessableImage('image/jpeg')).toBe(true);
    expect(isProcessableImage('image/png')).toBe(true);
    expect(isProcessableImage('image/webp')).toBe(true);
    expect(isProcessableImage('image/avif')).toBe(true);
    expect(isProcessableImage('application/pdf')).toBe(false);
    expect(isProcessableImage('text/csv')).toBe(false);
  });
});
