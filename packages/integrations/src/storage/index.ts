/**
 * Object storage (architecture §22).
 *
 * One interface, two drivers, and a small amount of shared law — key shape,
 * MIME allow-list, size caps — that both drivers and the module above them read
 * from here rather than each restating.
 */

export {
  StorageError,
  type PresignGetRequest,
  type PresignPutRequest,
  type SignedGet,
  type SignedPut,
  type StorageDriver,
  type StorageFailure,
  type StorageVisibility,
  type StoredObject,
} from './driver.js';

export { assertValidKey, buildStorageKey, variantKey } from './keys.js';

export {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  assertWithinLimit,
  mimeRuleFor,
  sniffMime,
  type MimeRule,
} from './limits.js';

export { LocalStorageDriver, type LocalDriverOptions } from './local-driver.js';
export { R2StorageDriver, type R2DriverOptions } from './r2-driver.js';

export { issueLocalToken, verifyLocalToken, type LocalTokenClaims } from './signing.js';

export {
  deriveSigningKey,
  hmacSha256,
  presign,
  uriEncode,
  type PresignRequest,
  type PresignedUrl,
  type SigV4Credentials,
} from './sigv4.js';
