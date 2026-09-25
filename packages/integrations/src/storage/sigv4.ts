import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, query-string ("presigned URL") flavour.
 *
 * Written out rather than pulled in with `@aws-sdk/client-s3` +
 * `@aws-sdk/s3-request-presigner`. The justification is proportionality: those
 * two packages bring roughly forty transitive modules and a middleware stack, to
 * do one deterministic HMAC chain over a canonical string. Presigning is also
 * the *only* S3 operation this repo performs — the browser does the PUT and the
 * GET, not us — so the SDK's value, which is the other two hundred operations
 * and their retry behaviour, is value we would not use.
 *
 * The risk of writing it is that a subtle canonicalization mistake produces URLs
 * Cloudflare rejects. `sigv4.test.ts` pins it down with AWS's own published
 * vectors: the signing-key derivation example, the `get-vanilla` case from the
 * AWS4 signature test suite reproduced end to end, and the canonical request
 * from the documentation's presigned-S3-GET example matched byte for byte —
 * canonicalization is where the bugs are, and that string is where they show.
 *
 * A wrong signature is a 403 from R2, which is loud, rather than a silent
 * weakening: there is no failure mode here where a bad signature grants more
 * than it should.
 *
 * Spec: AWS General Reference, "Create a signed AWS API request" and
 * "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Temporary credentials only; becomes `X-Amz-Security-Token`. */
  readonly sessionToken?: string | undefined;
}

export interface PresignRequest {
  readonly method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Host only, no scheme: `<account>.r2.cloudflarestorage.com`. */
  readonly host: string;
  /** Already-decoded path, with a leading slash: `/bucket/private/…/x.jpg`. */
  readonly path: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: SigV4Credentials;
  readonly expiresInSeconds: number;
  /** Extra query parameters to sign, e.g. `response-content-disposition`. */
  readonly query?: Readonly<Record<string, string>> | undefined;
  /**
   * Headers beyond `host` that the client must send and that are therefore
   * signed. Lowercase names. `content-type` on a PUT belongs here: signing it
   * is what stops a ticket issued for an image being used to store HTML.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Injectable so the test can reproduce a fixed vector. */
  readonly now?: Date | undefined;
}

/**
 * RFC 3986 encoding, which is not what `encodeURIComponent` does.
 *
 * `encodeURIComponent` leaves `!'()*` alone; SigV4 requires them encoded, and a
 * key containing `(` then signs differently from the URL that is sent. This is
 * the single most common way a hand-written SigV4 works for every test file and
 * fails on the first filename with a bracket in it.
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/.test(char)) {
      out += char;
    } else if (char === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

export function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * The signing key: a four-step HMAC chain down date, region, service, and the
 * literal `aws4_request`. Deriving it per request is deliberate — caching it
 * would keep a key material buffer alive across requests for no measurable win.
 *
 * Exported only so the test can run AWS's published derivation vector against
 * it. Nothing else calls it.
 */
export function deriveSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  return hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${secret}`, date), region), service),
    'aws4_request',
  );
}

export interface PresignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
  /** Exposed for the test vector, and for diagnosing a 403 from the provider. */
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

/**
 * Build a presigned URL.
 *
 * `UNSIGNED-PAYLOAD` is the payload hash in the canonical request, which is what
 * presigning means: the body is not known when the URL is made, so it cannot be
 * hashed. That is also why a PUT ticket must be narrow in every other
 * dimension — expiry, key, content type — since the bytes are unconstrained.
 */
export function presign(request: PresignRequest): PresignedUrl {
  const now = request.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${request.region}/${request.service}/aws4_request`;

  const headers: Record<string, string> = { host: request.host, ...(request.headers ?? {}) };
  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders =
    signedHeaderNames
      .map((name) => `${name}:${(headers[name] ?? '').trim().replace(/\s+/g, ' ')}`)
      .join('\n') + '\n';

  const query: Record<string, string> = {
    ...(request.query ?? {}),
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${request.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(request.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(request.credentials.sessionToken === undefined
      ? {}
      : { 'X-Amz-Security-Token': request.credentials.sessionToken }),
  };

  // Sorted by encoded name, then encoded value. Sorting the decoded names gives
  // a different order for anything above ASCII and signs a string the provider
  // will not recompute.
  const canonicalQuery = Object.entries(query)
    .map(([name, value]) => [uriEncode(name, true), uriEncode(value, true)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    request.method,
    uriEncode(request.path, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signature = hmacSha256(
    deriveSigningKey(
      request.credentials.secretAccessKey,
      shortDate,
      request.region,
      request.service,
    ),
    stringToSign,
  ).toString('hex');

  return {
    url: `https://${request.host}${uriEncode(request.path, false)}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + request.expiresInSeconds * 1000),
    canonicalRequest,
    stringToSign,
    signature,
  };
}
