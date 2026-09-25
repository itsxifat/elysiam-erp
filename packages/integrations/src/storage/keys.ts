import { StorageError, type StorageVisibility } from './driver.js';

/**
 * Storage keys, and the rules that keep one from becoming a path traversal.
 *
 * The local driver turns a key into a filesystem path, so a key containing
 * `..` is an arbitrary write anywhere the process can reach. The R2 driver
 * turns it into a URL path, where a bare `..` is collapsed by whatever
 * normalizes it first and a raw `#` truncates the key silently — the object
 * lands somewhere other than where the row says it is, which is worse than an
 * error because nothing reports it.
 *
 * So keys are validated once, here, and both drivers call it. The alternative —
 * each driver sanitizing in its own way — is two chances to get it right and
 * two different definitions of what a key is.
 */

/** Deliberately narrow: lowercase, digits, and the three separators. */
const KEY_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

const MAX_KEY_LENGTH = 512;

export function assertValidKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new StorageError('key-invalid', `Storage key must be 1-${String(MAX_KEY_LENGTH)} chars.`);
  }
  if (key.startsWith('/') || key.endsWith('/')) {
    throw new StorageError('key-invalid', 'Storage key must not start or end with "/".');
  }

  for (const segment of key.split('/')) {
    // `.` and `..` are caught by the pattern's required leading alphanumeric,
    // but they are named here because they are the whole reason for the check
    // and a future loosening of the pattern must not lose them.
    if (segment === '.' || segment === '..' || !KEY_SEGMENT.test(segment)) {
      throw new StorageError('key-invalid', `Storage key segment "${segment}" is not allowed.`);
    }
  }
}

/**
 * The key for one stored object.
 *
 * Shaped `<visibility>/<org>/<yyyy>/<mm>/<id><ext>`:
 *
 * - visibility first, so a bucket lifecycle rule or a CDN origin path can be
 *   written against a prefix rather than against a database query. §22 has two
 *   buckets; one bucket with two prefixes is the same boundary expressed where
 *   the CDN can see it.
 * - org second, so a mistaken bulk delete is bounded to one brand, and so an
 *   object listing cannot accidentally mix two brands' files.
 * - the year and month keep any single prefix small enough to list.
 * - the id is the row's uuid, never the uploaded filename. A filename is
 *   attacker-controlled text that routinely carries a customer's name, and
 *   invariant 10 says personal data does not go into places that get logged.
 *   The original name is kept on the row instead.
 */
export function buildStorageKey(input: {
  readonly visibility: StorageVisibility;
  readonly orgId: string;
  readonly fileId: string;
  readonly extension: string;
  readonly now?: Date;
}): string {
  const now = input.now ?? new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const extension = input.extension === '' ? '' : `.${input.extension.replace(/^\./, '')}`;
  const key = `${input.visibility}/${input.orgId}/${year}/${month}/${input.fileId}${extension}`;
  assertValidKey(key);
  return key;
}

/**
 * The key for one derived image variant, beside its original.
 *
 * A suffix rather than a sibling folder, so deleting the original's prefix
 * takes its variants with it. A variant orphaned from its original is a bill
 * nobody can explain.
 */
export function variantKey(originalKey: string, variant: string, extension: string): string {
  const withoutExtension = originalKey.replace(/\.[a-z0-9]+$/, '');
  const key = `${withoutExtension}.${variant}.${extension}`;
  assertValidKey(key);
  return key;
}
