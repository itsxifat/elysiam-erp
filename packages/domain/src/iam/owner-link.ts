/**
 * The owner sign-in link (D-473, M31; minted by the mother ERP, M32).
 *
 * A brand's ERP lets an owner in without a password of their own there: whoever holds the
 * private key mints a short-lived, single-use assertion, and the brand checks it against the
 * public key in its environment. This file is the format and the rules both sides share;
 * the signature itself is Ed25519 through `node:crypto`, on each side, outside this package.
 *
 * ## Format
 *
 * `<payload>.<signature>`, both unpadded base64url. The payload is the UTF-8 JSON of
 * {@link OwnerLinkClaims} as {@link encodeOwnerLinkPayload} writes it; the signature is
 * Ed25519 over the payload's **base64url text** (the bytes before the dot), so the verifier
 * never re-serialises anything before checking it.
 *
 * ## Why each rule
 *
 * - `aud` is the brand's slug: a link minted for one brand is refused by every other, so a
 *   leaked link opens at most the brand it was for.
 * - `exp − iat` is at most {@link OWNER_LINK_MAX_LIFETIME_SECONDS}: the link travels in a
 *   URL fragment through a browser, and two minutes is long enough for a redirect and short
 *   enough that a link copied out of a history entry is dead.
 * - `jti` is single use; the brand records it before it creates the session.
 * - Every refusal is the same refusal to the caller. The reason is for the brand's own log.
 */

export const OWNER_LINK_VERSION = 1;
export const OWNER_LINK_MAX_LIFETIME_SECONDS = 120;
/** Clocks on two servers disagree a little; a link "from the future" by more is refused. */
export const OWNER_LINK_CLOCK_SKEW_SECONDS = 30;
/** Generous for a JSON payload of these fields and a 64-byte signature. */
export const OWNER_LINK_MAX_LENGTH = 2048;

export interface OwnerLinkClaims {
  readonly v: typeof OWNER_LINK_VERSION;
  /** The brand's slug (`ERP_BRAND_SLUG` on the brand). */
  readonly aud: string;
  /** The owner's email, lower-cased: the identity on the brand. */
  readonly sub: string;
  /** Shown on the brand only to other owners (D-473). */
  readonly name: string;
  /** Single use; a UUID. */
  readonly jti: string;
  /** Unix seconds. */
  readonly iat: number;
  readonly exp: number;
}

export type OwnerLinkRefusal =
  | 'malformed'
  | 'bad_version'
  | 'wrong_audience'
  | 'not_yet_valid'
  | 'expired'
  | 'lifetime_too_long'
  | 'bad_signature';

export type OwnerLinkParse =
  | {
      readonly ok: true;
      readonly claims: OwnerLinkClaims;
      /** What the signature covers: the payload's base64url text. */
      readonly signedText: string;
      readonly signature: Uint8Array;
    }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_version' };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Unpadded base64url of UTF-8 text or bytes, without Buffer, so a browser can use it too. */
export function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * The payload's base64url text: what the minter signs and puts before the dot.
 *
 * Keys in a fixed order, so the same claims always give the same text.
 */
export function encodeOwnerLinkPayload(claims: OwnerLinkClaims): string {
  const ordered = {
    v: claims.v,
    aud: claims.aud,
    sub: claims.sub,
    name: claims.name,
    jti: claims.jti,
    iat: claims.iat,
    exp: claims.exp,
  };
  return toBase64Url(JSON.stringify(ordered));
}

export function assembleOwnerLink(payloadText: string, signature: Uint8Array): string {
  return `${payloadText}.${toBase64Url(signature)}`;
}

function isWholeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Splits and decodes a token. Says nothing about the signature or the time. */
export function parseOwnerLink(token: string): OwnerLinkParse {
  if (token.length === 0 || token.length > OWNER_LINK_MAX_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [signedText, signatureText] = parts as [string, string];
  const payloadBytes = fromBase64Url(signedText);
  const signature = fromBase64Url(signatureText);
  if (payloadBytes === undefined || signature?.length !== 64) {
    return { ok: false, reason: 'malformed' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed' };
  }
  const record = raw as Record<string, unknown>;
  if (record.v !== OWNER_LINK_VERSION) return { ok: false, reason: 'bad_version' };
  const { aud, sub, name, jti, iat, exp } = record;
  if (
    typeof aud !== 'string' ||
    !SLUG.test(aud) ||
    typeof sub !== 'string' ||
    sub !== sub.toLowerCase() ||
    !EMAIL.test(sub) ||
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > 200 ||
    typeof jti !== 'string' ||
    !UUID.test(jti) ||
    !isWholeSeconds(iat) ||
    !isWholeSeconds(exp)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    claims: { v: OWNER_LINK_VERSION, aud, sub, name, jti, iat, exp },
    signedText,
    signature,
  };
}

/**
 * The time and audience rules, after the signature has been checked.
 *
 * `nowSeconds` is the brand's clock. Returns the refusal, or `undefined` when the claims
 * are good. Single use (`jti`) is the caller's, because it needs the database.
 */
export function checkOwnerLinkClaims(
  claims: OwnerLinkClaims,
  options: { readonly audience: string; readonly nowSeconds: number },
): OwnerLinkRefusal | undefined {
  if (claims.aud !== options.audience) return 'wrong_audience';
  if (claims.exp <= claims.iat) return 'malformed';
  if (claims.exp - claims.iat > OWNER_LINK_MAX_LIFETIME_SECONDS) return 'lifetime_too_long';
  if (claims.iat > options.nowSeconds + OWNER_LINK_CLOCK_SKEW_SECONDS) return 'not_yet_valid';
  if (options.nowSeconds >= claims.exp) return 'expired';
  return undefined;
}
