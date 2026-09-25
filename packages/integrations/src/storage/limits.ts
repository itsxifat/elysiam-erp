import { StorageError } from './driver.js';

/**
 * What may be uploaded, and how big (architecture §22 "size and MIME limits").
 *
 * An allow-list, not a deny-list, and the asymmetry is the point. A deny-list of
 * dangerous types is a list of the ones somebody thought of: `image/svg+xml`
 * carries script, `text/html` served from our own domain is stored XSS against
 * every session cookie scoped to it, and `application/xhtml+xml` is the same
 * thing under a name most lists forget. Nothing here needs any of them.
 *
 * The caps are per type rather than global because the honest ceiling differs
 * by an order of magnitude: a courier's delivery photo is a phone JPEG, a
 * signed distributor agreement is a scanned PDF. One global cap set high enough
 * for the PDF would let a product image be 20 MB.
 */

const MiB = 1024 * 1024;

export interface MimeRule {
  readonly mime: string;
  readonly maxBytes: number;
  /** The extension the key gets. Never taken from the uploaded filename. */
  readonly extension: string;
  /** Whether the image job re-encodes it into variants and strips EXIF. */
  readonly isImage: boolean;
}

export const ALLOWED_MIME_TYPES: readonly MimeRule[] = [
  { mime: 'image/jpeg', maxBytes: 12 * MiB, extension: 'jpg', isImage: true },
  { mime: 'image/png', maxBytes: 12 * MiB, extension: 'png', isImage: true },
  { mime: 'image/webp', maxBytes: 12 * MiB, extension: 'webp', isImage: true },
  { mime: 'image/avif', maxBytes: 12 * MiB, extension: 'avif', isImage: true },
  /*
   * Scans: KYC documents, supplier agreements, bank statements (§22 private
   * bucket). 25 MiB because a ten-page phone scan really is that big, and a
   * reseller who cannot upload their trade licence stops being a reseller.
   */
  { mime: 'application/pdf', maxBytes: 25 * MiB, extension: 'pdf', isImage: false },
  /*
   * Courier settlement sheets and supplier price lists arrive as spreadsheets
   * (§12, §9). Stored, never executed, and never rendered in a browser: the
   * download endpoint serves them as an attachment.
   */
  { mime: 'text/csv', maxBytes: 8 * MiB, extension: 'csv', isImage: false },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    maxBytes: 16 * MiB,
    extension: 'xlsx',
    isImage: false,
  },
];

const BY_MIME = new Map(ALLOWED_MIME_TYPES.map((rule) => [rule.mime, rule]));

/**
 * The rule for a declared MIME type, or a refusal.
 *
 * Parameters are stripped first (`image/jpeg; charset=binary` is a real thing
 * browsers send) and the type is lowercased, because a case-sensitive
 * comparison against `IMAGE/JPEG` rejects a legitimate upload while
 * `text/HTML` would still be rejected — failing in the annoying direction and
 * not the dangerous one, but failing.
 */
export function mimeRuleFor(declared: string): MimeRule {
  const mime = (declared.split(';')[0] ?? '').trim().toLowerCase();
  const rule = BY_MIME.get(mime);
  if (rule === undefined) {
    throw new StorageError('mime-rejected', `Files of type "${mime}" cannot be uploaded.`);
  }
  return rule;
}

/** The largest upload any rule allows, for a blanket body limit. */
export const MAX_UPLOAD_BYTES = ALLOWED_MIME_TYPES.reduce(
  (largest, rule) => Math.max(largest, rule.maxBytes),
  0,
);

export function assertWithinLimit(sizeBytes: number, rule: MimeRule): void {
  if (sizeBytes <= 0) {
    throw new StorageError('too-large', 'An upload must contain at least one byte.');
  }
  if (sizeBytes > rule.maxBytes) {
    throw new StorageError(
      'too-large',
      `A ${rule.mime} file may be at most ${String(Math.floor(rule.maxBytes / MiB))} MiB.`,
    );
  }
}

/**
 * What the bytes actually are, from their magic number.
 *
 * The declared MIME type is what the client *said*. This is what arrived. They
 * disagree in two ways that matter: an honest browser mislabelling a file, and
 * a deliberate upload of HTML declared as `image/png` so that the download
 * endpoint's `Content-Type` — which comes from the row — makes a browser render
 * it as a page. The second is why this runs on ingest and not only in tests.
 *
 * Returns `null` when the bytes match no signature we know, which for the
 * non-image types is normal: CSV has no magic number. The caller decides.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]): boolean =>
    signature.length <= bytes.length && signature.every((byte, index) => bytes[index] === byte);

  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.length >= 12) {
    const tag = String.fromCharCode(...bytes.subarray(8, 12));
    if (tag === 'WEBP') return 'image/webp';
  }
  // ISO-BMFF: `....ftypavif` / `....ftypavis`
  if (bytes.length >= 12) {
    const brand = String.fromCharCode(...bytes.subarray(4, 12));
    if (brand === 'ftypavif' || brand === 'ftypavis') return 'image/avif';
  }
  // A .xlsx is a zip. That is as far as a magic number gets, and it is enough
  // to tell it is not HTML.
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  return null;
}
