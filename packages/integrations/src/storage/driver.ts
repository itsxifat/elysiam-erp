/**
 * The storage driver interface (architecture §22).
 *
 * Two implementations, and the reason there are two is not convenience. The
 * `local` driver exists so tests and development never touch Cloudflare, and
 * the `r2` driver is what staging and production run. Both sit behind this
 * interface so the module above them cannot tell which it is talking to — the
 * moment a service branches on the driver, the tests stop testing production.
 *
 * Every method that hands out a URL takes an expiry and returns the instant it
 * stops working. That return value is not decoration: §22 says a private object
 * is served "only through short-lived signed URLs after an authorization
 * check", and a caller that cannot see the expiry cannot assert it. Acceptance
 * check 4 asserts exactly that, and it needs the number.
 */

/** Which bucket an object lives in (§22). Decides who may be handed a URL. */
export type StorageVisibility = 'private' | 'public';

export interface SignedGet {
  /** A URL that serves the bytes, and stops serving them at `expiresAt`. */
  readonly url: string;
  readonly expiresAt: Date;
}

export interface SignedPut {
  readonly url: string;
  /** Always PUT. Named so a client does not have to guess (§22 "presigned PUT"). */
  readonly method: 'PUT';
  /**
   * Headers the client MUST send, because they are part of what was signed.
   *
   * `Content-Type` is signed rather than merely suggested: an upload ticket
   * issued for `image/webp` that accepted `text/html` would turn the public
   * bucket into a place to host script on our own domain.
   */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
  /**
   * The byte ceiling this ticket was issued under.
   *
   * Advisory on the URL for R2 — S3 presigning cannot bind a maximum to a PUT
   * without POST policy — and enforced on ingest either way, which is where the
   * check has to live regardless. Returned so the caller can tell the client
   * before it spends a minute uploading something that will be rejected.
   */
  readonly maxBytes: number;
}

export interface PresignPutRequest {
  readonly key: string;
  readonly contentType: string;
  readonly maxBytes: number;
  readonly expiresInSeconds: number;
}

export interface PresignGetRequest {
  readonly key: string;
  readonly expiresInSeconds: number;
  /**
   * Turns the response into a download with this filename.
   *
   * Set for invoices and payslips, which are saved rather than viewed. It is
   * part of the signature, so a caller cannot rewrite it on the way through.
   */
  readonly downloadFilename?: string | undefined;
}

export interface StoredObject {
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface StorageDriver {
  /** `local` or `r2`. Recorded on the row so a key can be resolved later. */
  readonly kind: 'local' | 'r2';

  presignPut(request: PresignPutRequest): Promise<SignedPut>;
  presignGet(request: PresignGetRequest): Promise<SignedGet>;

  /**
   * Write bytes directly, bypassing the presigned path.
   *
   * For things the server produces rather than receives: a rendered invoice, an
   * image variant. Not a shortcut for uploads — an upload that went through the
   * API process would put the whole file in this process's memory, which is the
   * reason presigned PUT exists.
   */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;

  get(key: string): Promise<Uint8Array>;

  /** Metadata without the bytes, or `null` if nothing is there. */
  head(key: string): Promise<StoredObject | null>;

  remove(key: string): Promise<void>;
}

/**
 * Something the storage layer refused, with a reason a caller can branch on.
 *
 * Distinct from a generic `Error` because the HTTP layer has to turn "you asked
 * for a key that does not exist" into 404 and "that MIME type is not allowed"
 * into 400, and matching on message text is how that quietly stops working.
 */
export type StorageFailure =
  | 'key-invalid'
  | 'not-found'
  | 'mime-rejected'
  | 'too-large'
  | 'signature-invalid'
  | 'expired'
  | 'driver-unavailable';

export class StorageError extends Error {
  constructor(
    readonly failure: StorageFailure,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
