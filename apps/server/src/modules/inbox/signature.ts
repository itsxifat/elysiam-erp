import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta's webhook signature (M42, D-732).
 *
 * Graph API Webhooks › Getting started: Meta signs every event notification "using the payload
 * and your app's App Secret" with SHA256 and sends it in `X-Hub-Signature-256`, "preceded with
 * `sha256=`". The Messenger Platform's webhook page adds that "we generate the signature using an
 * escaped unicode version of the payload, with lowercase hex digits" (`äöå` → `äöå`).
 *
 * So the HMAC is checked over the exact bytes received and, when those hold anything outside
 * ASCII, over the same text with every non-ASCII character written as a lowercase `\uXXXX`
 * escape (astral characters as their surrogate pair, as JSON writes them). Either matching is a
 * match; both comparisons are constant time. Nothing about why a signature failed is returned to
 * the caller.
 */

const PREFIX = 'sha256=';

/** `ä` → `ä`, `😀` → `😀`: every UTF-16 unit above 0x7f, lowercase hex. */
export function escapedUnicode(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    out += unit > 0x7f ? `\\u${unit.toString(16).padStart(4, '0')}` : text[index];
  }
  return out;
}

function hmac(secret: string, body: Buffer): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

function equalHex(expected: Buffer, givenHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(givenHex)) return false;
  const given = Buffer.from(givenHex, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** True when `header` is a valid `sha256=` signature of `rawBody` under `appSecret`. */
export function metaSignatureMatches(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (header === undefined || !header.startsWith(PREFIX) || appSecret === '') return false;
  const given = header.slice(PREFIX.length).trim();
  if (equalHex(hmac(appSecret, rawBody), given)) return true;

  // Only bodies with non-ASCII bytes have a different escaped form.
  if (!rawBody.some((byte) => byte > 0x7f)) return false;
  const escaped = Buffer.from(escapedUnicode(rawBody.toString('utf8')), 'utf8');
  return equalHex(hmac(appSecret, escaped), given);
}

/** The header Meta would send for `body`: for tests and the stack spec's fake webhooks. */
export function metaSignatureFor(rawBody: Buffer | string, appSecret: string): string {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return `${PREFIX}${hmac(appSecret, bytes).toString('hex')}`;
}
