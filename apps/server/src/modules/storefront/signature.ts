import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How the brand's website signs its calls to the storefront API (M33, D-506).
 *
 * The intake's scheme (M11, `intake/signature.ts`), reused for everything but two things:
 *
 * * **Its own derivation label.** A website key's secret is
 *   `HMAC-SHA256(master key, "storefront.site-key.v1:" + key id)`, where an intake key's is
 *   derived under the intake's label. Same master key, different secrets: a landing page's
 *   key cannot read the catalog and the website's key cannot post a landing-page order,
 *   and nothing needs a second secret deployed (D-509).
 * * **What is signed.** A read has no body, so the method and the exact path and query are
 *   signed instead, which is what stops a captured `GET …/products?category=men` from being
 *   replayed as `…/products/<slug>`. A write (M34's checkout) adds the idempotency key and
 *   the raw body bytes after them, the intake's rule.
 *
 *   `v1 = timestamp + "." + METHOD + "." + pathAndQuery` (GET)
 *   `v1 = timestamp + "." + METHOD + "." + pathAndQuery + "." + idempotencyKey + "." + body` (POST)
 *
 *   `pathAndQuery` is the request target exactly as sent (`/storefront/v1/catalog/products?
 *   page=2&sort=newest`): no re-encoding, no sorting of parameters. The client signs the
 *   string it puts on the wire; the server checks the string it received.
 *
 * Key ids, the org inside them, fingerprints and the clock window are the intake's own
 * functions, imported rather than copied, so the two schemes cannot drift apart where they
 * are meant to agree.
 */

export { fingerprint, isKeyId, newKeyId, orgIdOf, timestampFresh } from '../intake/signature.js';

const DERIVATION_LABEL = 'storefront.site-key.v1:';
const SIGNATURE_SHAPE = /^sha256=([0-9a-f]{64})$/;

/** The headers a signed call carries. Lower-case, as Node hands them over. */
export const KEY_HEADER = 'x-api-key';
export const TIMESTAMP_HEADER = 'x-api-timestamp';
export const SIGNATURE_HEADER = 'x-api-signature';

/** A website key's signing secret, derived and never stored. */
export function deriveStorefrontSecret(masterKey: string, keyId: string): string {
  const digest = createHmac('sha256', masterKey).update(`${DERIVATION_LABEL}${keyId}`).digest();
  return `sk_${digest.toString('base64url')}`;
}

export interface SignedRequest {
  readonly timestamp: string;
  readonly method: string;
  /** The request target as sent: path and query string, exactly. */
  readonly pathAndQuery: string;
  /** Writes only. */
  readonly idempotencyKey?: string;
  /** Writes only: the raw body bytes. */
  readonly rawBody?: Buffer;
}

/** The exact bytes that are signed. */
export function storefrontSigningBase(request: SignedRequest): Buffer {
  const head = `${request.timestamp}.${request.method.toUpperCase()}.${request.pathAndQuery}`;
  if (request.rawBody === undefined) return Buffer.from(head, 'utf8');
  return Buffer.concat([
    Buffer.from(`${head}.${request.idempotencyKey ?? ''}.`, 'utf8'),
    request.rawBody,
  ]);
}

/** The header value a correct client sends. The tests' and the documentation's reference. */
export function signStorefront(secret: string, request: SignedRequest): string {
  const mac = createHmac('sha256', secret).update(storefrontSigningBase(request)).digest('hex');
  return `sha256=${mac}`;
}

/**
 * Whether the signature header is right for this request. Constant time over the digest; the
 * header's shape is checked first in ordinary time, which leaks nothing (every correct
 * header has the same shape).
 */
export function storefrontSignatureMatches(
  secret: string,
  header: string,
  request: SignedRequest,
): boolean {
  const given = SIGNATURE_SHAPE.exec(header.trim())?.[1];
  if (given === undefined) return false;
  const expected = createHmac('sha256', secret).update(storefrontSigningBase(request)).digest();
  return timingSafeEqual(Buffer.from(given, 'hex'), expected);
}

/** A response body's strong ETag: its SHA-256, quoted. */
export function etagOf(body: string): string {
  return `"${createHash('sha256').update(body, 'utf8').digest('base64url')}"`;
}
