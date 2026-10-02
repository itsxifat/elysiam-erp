import {
  StorageError,
  type PresignGetRequest,
  type PresignPutRequest,
  type SignedGet,
  type SignedPut,
  type StorageDriver,
  type StoredObject,
} from './driver.js';
import { assertValidKey } from './keys.js';
import { presign, uriEncode } from './sigv4.js';

/**
 * Cloudflare R2, through the S3-compatible API (architecture §22, §21).
 *
 * **UNVERIFIED against a live bucket.** There are no R2 credentials in this
 * repo and none were available for this milestone, so this driver has been
 * exercised only against its own unit tests and against the SigV4 vectors in
 * `sigv4.test.ts`. Architecture §21's rule — build only against official docs,
 * never invent endpoints or fields — is why it is written to the documented S3
 * shape rather than to a guess, and D-113 records it as unverified so the first
 * deployment treats it as something to check rather than something that works.
 *
 * The three documented facts it is built on, from Cloudflare's "R2 S3 API
 * compatibility" and AWS's S3 reference:
 *
 * - the endpoint is `https://<account-id>.r2.cloudflarestorage.com`
 * - the region for signing is the literal `auto`
 * - presigned `GET`/`PUT` are supported, and `PUT` cannot carry a size policy
 *   (that needs POST policy documents, which R2 does not implement) — which is
 *   why the ceiling is enforced on ingest and only advertised on the ticket
 */
export interface R2DriverOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * The CDN hostname public objects are served from (§22 "public bucket …
   * through the CDN").
   *
   * When set, a public object's URL is this host plus the key and never expires.
   * Public means public: signing a URL for a product image would make every
   * catalogue page a stream of one-time links, break browser caching, and still
   * not keep the image secret.
   */
  readonly publicBaseUrl?: string | undefined;
  /** Injectable so tests can point at a local S3 double without a network. */
  readonly endpointOverride?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

const REGION = 'auto';
const SERVICE = 's3';

export class R2StorageDriver implements StorageDriver {
  readonly kind = 'r2' as const;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: R2DriverOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private get host(): string {
    const override = this.options.endpointOverride;
    if (override !== undefined) return new URL(override).host;
    return `${this.options.accountId}.r2.cloudflarestorage.com`;
  }

  /**
   * The request path: `/<bucket>/<key>`.
   *
   * Path style, not virtual-host style. R2 documents both, and path style is the
   * one that works for every bucket name — a bucket with a dot in it makes a
   * virtual-host URL fail TLS hostname verification, which surfaces as a
   * certificate error nobody connects to a naming choice.
   */
  private pathFor(key: string): string {
    assertValidKey(key);
    return `/${this.options.bucket}/${key}`;
  }

  private assertExpiry(seconds: number): void {
    // S3's own ceiling for a SigV4 presigned URL is 7 days. This caps far lower:
    // §22 says "short-lived", and a URL that outlives the permission that
    // produced it is exactly what acceptance check 4 is about.
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86_400) {
      throw new StorageError('key-invalid', 'A signed URL must expire within 1..86400 seconds.');
    }
  }

  // `async` for the same reason as the local driver: `assertExpiry` and
  // `assertValidKey` throw, and a method that throws synchronously on some
  // inputs and rejects on others forces every caller to handle both.
  async presignPut(request: PresignPutRequest): Promise<SignedPut> {
    this.assertExpiry(request.expiresInSeconds);
    const signed = presign({
      method: 'PUT',
      host: this.host,
      path: this.pathFor(request.key),
      region: REGION,
      service: SERVICE,
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
      expiresInSeconds: request.expiresInSeconds,
      // Signed, not merely expected. An unsigned content type lets the holder of
      // the ticket store `text/html` under a key the CDN serves, which is stored
      // XSS on our own domain.
      headers: { 'content-type': request.contentType },
    });

    return await Promise.resolve({
      url: signed.url,
      method: 'PUT',
      headers: { 'content-type': request.contentType },
      expiresAt: signed.expiresAt,
      maxBytes: request.maxBytes,
    });
  }

  async presignGet(request: PresignGetRequest): Promise<SignedGet> {
    this.assertExpiry(request.expiresInSeconds);
    const signed = presign({
      method: 'GET',
      host: this.host,
      path: this.pathFor(request.key),
      region: REGION,
      service: SERVICE,
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
      expiresInSeconds: request.expiresInSeconds,
      ...(request.downloadFilename === undefined
        ? {}
        : {
            query: {
              // Quoted and with the quotes escaped: a filename containing `"`
              // would otherwise terminate the header value early and let the
              // rest of the name become header parameters.
              'response-content-disposition': `attachment; filename="${request.downloadFilename.replace(/["\\]/g, '')}"`,
            },
          }),
    });

    return await Promise.resolve({ url: signed.url, expiresAt: signed.expiresAt });
  }

  /**
   * The unexpiring CDN URL for a public object.
   *
   * Separate from `presignGet` because the two answer different questions and
   * collapsing them would mean a caller could accidentally hand out a permanent
   * URL for a private object. This one refuses anything outside the `public/`
   * prefix for that reason.
   */
  publicUrl(key: string): string {
    assertValidKey(key);
    if (!key.startsWith('public/')) {
      throw new StorageError('key-invalid', 'Only objects under public/ have a CDN URL.');
    }
    const base = this.options.publicBaseUrl;
    if (base === undefined) {
      throw new StorageError('driver-unavailable', 'No CDN base URL is configured for R2.');
    }
    return `${base.replace(/\/+$/, '')}/${uriEncode(key, false)}`;
  }

  private async signedRequest(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    init: { body?: Uint8Array; contentType?: string } = {},
  ): Promise<Response> {
    const signed = presign({
      method,
      host: this.host,
      path: this.pathFor(key),
      region: REGION,
      service: SERVICE,
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
      // 60s: this is a server-to-server call made immediately, so the window
      // only has to cover one request. A long window here would be a credential
      // sitting in a log line.
      expiresInSeconds: 60,
      ...(init.contentType === undefined ? {} : { headers: { 'content-type': init.contentType } }),
    });

    return this.fetchImpl(signed.url, {
      method,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.contentType === undefined ? {} : { headers: { 'content-type': init.contentType } }),
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const response = await this.signedRequest('PUT', key, { body: bytes, contentType });
    if (!response.ok) {
      // The status, never the body: an S3 error body echoes the request, which
      // includes the signed URL and therefore a live credential (invariant 10).
      throw new StorageError(
        'driver-unavailable',
        `R2 refused a write: ${String(response.status)}`,
      );
    }
  }

  async get(key: string, options: { readonly maxBytes?: number } = {}): Promise<Uint8Array> {
    const response = await this.signedRequest('GET', key);
    if (response.status === 404) throw new StorageError('not-found', 'No such stored object.');
    if (!response.ok) {
      throw new StorageError('driver-unavailable', `R2 refused a read: ${String(response.status)}`);
    }
    if (options.maxBytes === undefined) return new Uint8Array(await response.arrayBuffer());
    return readCapped(response, options.maxBytes);
  }

  async head(key: string): Promise<StoredObject | null> {
    const response = await this.signedRequest('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StorageError('driver-unavailable', `R2 refused a head: ${String(response.status)}`);
    }
    return {
      sizeBytes: Number(response.headers.get('content-length') ?? '0'),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async remove(key: string): Promise<void> {
    const response = await this.signedRequest('DELETE', key);
    // 404 is success: the caller asked for it to be gone and it is gone.
    if (!response.ok && response.status !== 404) {
      throw new StorageError(
        'driver-unavailable',
        `R2 refused a delete: ${String(response.status)}`,
      );
    }
  }
}

/**
 * A response body, read only up to `maxBytes` (D-417).
 *
 * The declared length is believed only as a reason to stop early, never as a reason to
 * keep reading: the stream is counted as it arrives and cancelled the moment it passes
 * the ceiling, so an object swapped for a larger one after the size check costs at most
 * the ceiling in memory.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new StorageError('too-large', `The stored object is larger than ${String(maxBytes)} bytes.`);
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  // Typed here: the fetch body's chunk type is `any` in this package's library types.
  const body = response.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (reader === undefined) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
