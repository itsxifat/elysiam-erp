import { createHmac, timingSafeEqual } from 'node:crypto';

import { parseEnvoSignature, signatureFresh } from '@elysium/domain/telephony';

/**
 * Envo's webhook signature (M47, D-832), as its `deliver` writes it: `X-Envo-Signature:
 * t=<unix seconds>,v1=<hex>`, the hex being HMAC-SHA256 of `${t}.${body}` under the webhook's
 * secret, over the exact bytes sent. Checked over the raw bytes, in constant time, and only when
 * the timestamp is within five minutes either way, so a captured delivery cannot be replayed
 * later. Why a signature failed is told to nobody but the connection's own record.
 */

export type SignatureVerdict = 'ok' | 'missing' | 'bad_signature' | 'stale';

function hmac(secret: string, timestamp: number, body: Buffer): Buffer {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.`, 'utf8')
    .update(body)
    .digest();
}

export function envoSignatureVerdict(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignatureVerdict {
  const parsed = parseEnvoSignature(header);
  if (parsed === null || secret === '') return 'missing';
  const expected = hmac(secret, parsed.timestamp, rawBody);
  const matches = parsed.signatures.some((hex) => {
    const given = Buffer.from(hex, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) return 'bad_signature';
  return signatureFresh(parsed.timestamp, nowSeconds) ? 'ok' : 'stale';
}

/** The header Envo would send for `body`: for tests and a stand-in for Envo. */
export function envoSignatureFor(
  rawBody: Buffer | string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return `t=${String(timestamp)},v1=${hmac(secret, timestamp, bytes).toString('hex')}`;
}
