import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { add, mulQty, poisha, sub, sum, ZERO, type Poisha } from '../money/index.js';
import type { OrderStatus } from '../orders/state.js';
import { takaDecimal } from './price.js';

/**
 * The ncom.bd marketplace's "contract 1" (M35b, D-553, D-556), ported from the old site's
 * `lib/ncom-signature.js`, `lib/ncom-connector.js` and `lib/ncom-orders.js`.
 *
 * ncom keeps no copy of the brand's catalogue: it reads the ERP's connector on every landing
 * page render, cart and checkout, may hold units through it before writing an order, and —
 * when the brand handles ncom's orders itself — hands each order to the ERP and hears back
 * what became of it. One signing scheme in both directions:
 *
 *     X-NCOM-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>
 *
 * A GET signs the empty body (`"<t>."`). The functions below are pure (the clock is passed in)
 * so the scheme is property-tested here and the server only wires it to requests.
 */

/** A request older or newer than this is a replay or a drifted clock, not a live call. */
export const NCOM_SKEW_SECONDS = 300;
/** The contract the connector implements, answered on `/ping` and checked on every call. */
export const NCOM_CONTRACT = '1';
/** Prices are read by ncom as the workspace currency and never converted: say which. */
export const NCOM_PRICE_CURRENCY = 'BDT';

const HEX_64 = /^[0-9a-f]{64}$/i;
const UNIX_SECONDS = /^\d{1,15}$/;

/** `t=…,v1=…` into its parts. Spaces and extra fields are tolerated, as ncom's docs allow. */
export function parseNcomSignatureHeader(header: string | undefined): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const piece of (header ?? '').split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    parts[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return parts;
}

/** The hex digest over the timestamp token and the exact body bytes. */
export function ncomSign(
  secret: string,
  timestamp: string | number,
  rawBody: Buffer | string = '',
): string {
  const prefix = Buffer.from(`${String(timestamp)}.`, 'utf8');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  return createHmac('sha256', secret)
    .update(Buffer.concat([prefix, body]))
    .digest('hex');
}

/** The header value for a request the ERP makes (the outbox, D-556). */
export function ncomSignatureHeader(
  secret: string,
  rawBody: Buffer | string,
  timestampSeconds: number,
): string {
  return `t=${String(timestampSeconds)},v1=${ncomSign(secret, timestampSeconds, rawBody)}`;
}

/** Constant time, and never throws on a malformed input. */
export function ncomHexEquals(a: string, b: string): boolean {
  if (!HEX_64.test(a) || !HEX_64.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Two opaque credentials (a key id), compared in constant time: hashed first, so neither the
 * length nor the content of the expected value shows in the time the answer takes.
 */
export function ncomSecretEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export type NcomVerification =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Check an inbound `X-NCOM-Signature`. The reason is for the ERP's log and the Marketplace
 * screen, never for the caller, who is told only 401.
 */
export function verifyNcomSignature(
  secret: string,
  rawBody: Buffer | string,
  header: string | undefined,
  nowMs: number,
): NcomVerification {
  if (secret === '') return { ok: false, reason: 'no signing secret configured' };
  const parts = parseNcomSignatureHeader(header);
  const t = parts.t;
  const v1 = parts.v1;
  if (t === undefined || v1 === undefined || t === '' || v1 === '') {
    return { ok: false, reason: 'malformed signature header' };
  }
  if (!UNIX_SECONDS.test(t)) return { ok: false, reason: 'malformed timestamp' };
  const skew = Math.abs(nowMs / 1000 - Number(t));
  if (skew > NCOM_SKEW_SECONDS) {
    return { ok: false, reason: `timestamp is ${String(Math.round(skew))}s out` };
  }
  // Signed with the timestamp token as it arrived: re-formatting it could change the bytes.
  if (!ncomHexEquals(ncomSign(secret, t, rawBody), v1)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, timestamp: Number(t) };
}

// --- the connector's shapes ---------------------------------------------------------------

/** A price as ncom reads it: a decimal string of taka (contract 1's primary form). */
export function ncomPrice(amount: Poisha): string {
  return takaDecimal(amount);
}

/** Ids can arrive repeated (`?ids=a&ids=b`) or comma-joined (`?ids=a,b`), in the order asked. */
export function ncomIdsFrom(values: readonly string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const piece of value.split(',')) {
      const id = piece.trim();
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** An opaque page cursor: base64url JSON naming the last id served, as ncom's example does. */
export function encodeNcomCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

export function decodeNcomCursor(cursor: string | undefined): string | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const id = (parsed as { id?: unknown } | null)?.id;
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Sizes that are no real choice: a single-variant product in one of these offers no option. */
const GENERIC_SIZES = new Set(['OS', 'FS', 'ONE SIZE', 'FREE SIZE', 'FREE', '']);

export function isMeaningfulSize(size: string | null): boolean {
  return !GENERIC_SIZES.has((size ?? '').trim().toUpperCase());
}

/**
 * Lines asked to be held, summed per variant first: a basket listing one variant twice must
 * not slip two checks past a stock of one. Lines without an id or a positive quantity drop.
 */
export function mergeNcomLines(
  lines: unknown,
): { readonly variantId: string; readonly quantity: number }[] {
  const merged = new Map<string, number>();
  for (const line of Array.isArray(lines) ? (lines as unknown[]) : []) {
    const record = (line ?? {}) as { variantId?: unknown; id?: unknown; quantity?: unknown };
    const raw = record.variantId ?? record.id;
    const variantId = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    const quantity = Math.floor(Number(record.quantity) || 0);
    if (variantId === '' || quantity <= 0 || !Number.isSafeInteger(quantity)) continue;
    merged.set(variantId, (merged.get(variantId) ?? 0) + quantity);
  }
  return [...merged.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

// --- orders handed over (D-556) -----------------------------------------------------------

/** Integer minor units, as ncom sends them (`*Cents`): poisha. Anything else is zero. */
export function ncomCents(value: unknown): Poisha {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return poisha(value);
  if (typeof value === 'string' && /^\d{1,16}$/.test(value)) return poisha(value);
  return ZERO;
}

export interface NcomOurLine {
  readonly qty: number;
  /** ncom's unit price for the line: the price the shopper agreed to. */
  readonly unitPricePoisha: Poisha;
}

/**
 * What an order handed over by ncom costs in the ERP (D-556): **ncom's prices, as they are**.
 *
 * The shopper agreed to a bundle price on ncom's page, so the ERP does not reprice it. The
 * lines the brand sells carry ncom's unit prices; delivery is ncom's shipping total; the order
 * discount is whatever makes the COD equal ncom's total. A line for something ncom stores
 * itself is recorded on the order but is not the brand's to ship or collect for: when those
 * lines carry money, the brand's COD covers its own goods and delivery only (`foreignPoisha`
 * is the difference, collected by whoever ships them), and the order says so.
 */
export function ncomOrderMoney(input: {
  readonly ours: readonly NcomOurLine[];
  readonly shippingTotalCents: unknown;
  readonly totalCents: unknown;
}): {
  readonly itemsPoisha: Poisha;
  readonly deliveryPoisha: Poisha;
  readonly discountPoisha: Poisha;
  readonly codPoisha: Poisha;
  /** What ncom's total carries beyond the brand's own goods and delivery. */
  readonly foreignPoisha: Poisha;
} {
  const items = sum(input.ours.map((line) => mulQty(line.unitPricePoisha, line.qty)));
  const delivery = ncomCents(input.shippingTotalCents);
  const total = ncomCents(input.totalCents);
  const gross = add(items, delivery);
  if (total <= gross) {
    // The discount cannot take the goods below nothing: delivery is never discounted here.
    const discount = sub(gross, total);
    const capped = discount > items ? items : discount;
    return {
      itemsPoisha: items,
      deliveryPoisha: delivery,
      discountPoisha: capped,
      codPoisha: sub(gross, capped),
      foreignPoisha: ZERO,
    };
  }
  return {
    itemsPoisha: items,
    deliveryPoisha: delivery,
    discountPoisha: ZERO,
    codPoisha: gross,
    foreignPoisha: sub(total, gross),
  };
}

/**
 * The ERP's status in the words ncom has always been sent (`pending`, `processing`,
 * `shipped`, `delivered`, `cancelled`), with the exact status travelling beside it as
 * `fulfilmentStatus`. A full return is `cancelled` for ncom's order book, as the old site
 * reported it.
 */
export function ncomStatusFor(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'confirmed':
    case 'on_hold':
    case 'packed':
      return 'processing';
    case 'shipped':
      return 'shipped';
    case 'delivered':
    case 'partially_delivered':
    case 'return_in_transit':
    case 'exchange':
      return 'delivered';
    case 'returned':
    case 'cancelled':
      return 'cancelled';
  }
}

/** The topic a change of status is sent to ncom as. */
export function ncomTopicFor(status: OrderStatus): 'order.cancelled' | 'order.updated' {
  return status === 'cancelled' ? 'order.cancelled' : 'order.updated';
}

/** Attempts per outbound message, the first included (the old site's). */
export const NCOM_OUTBOX_MAX_ATTEMPTS = 8;
/** Seconds to wait after each failed attempt: 15 s, 1 m, 5 m, 15 m, 1 h, 3 h, 6 h. */
export const NCOM_OUTBOX_BACKOFF_SECONDS = [15, 60, 300, 900, 3_600, 10_800, 21_600] as const;

export type NcomDelivery =
  | { readonly state: 'delivered' }
  | { readonly state: 'refused'; readonly reason: string }
  | { readonly state: 'retry'; readonly afterSeconds: number }
  | { readonly state: 'failed'; readonly reason: string };

/**
 * What one attempt's answer means for an outbound message (`attempt` counts from 1):
 * delivered on any 2xx; **refused for good** on a 409 (ncom holds a version the ERP did not
 * produce: a person must look) or any other 4xx but 408 and 429; otherwise retried on the
 * backoff, and failed once the attempts run out. No answer at all (`status` null) is always
 * retried: the request may well have been processed.
 */
export function ncomDeliveryOutcome(status: number | null, attempt: number): NcomDelivery {
  if (status !== null && status >= 200 && status < 300) return { state: 'delivered' };
  if (status === 409) return { state: 'refused', reason: 'version_conflict' };
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { state: 'refused', reason: `http_${String(status)}` };
  }
  if (attempt >= NCOM_OUTBOX_MAX_ATTEMPTS) {
    return { state: 'failed', reason: status === null ? 'unreachable' : `http_${String(status)}` };
  }
  const index = Math.min(attempt - 1, NCOM_OUTBOX_BACKOFF_SECONDS.length - 1);
  return { state: 'retry', afterSeconds: NCOM_OUTBOX_BACKOFF_SECONDS[index] ?? 21_600 };
}

// --- addresses ------------------------------------------------------------------------------

/** Old and new spellings of districts that ncom's free-text "city" may use. */
const DISTRICT_ALIASES: Readonly<Record<string, string>> = {
  chittagong: 'chattogram',
  ctg: 'chattogram',
  comilla: 'cumilla',
  barisal: 'barishal',
  bogra: 'bogura',
  jessore: 'jashore',
  chapainawabganj: 'chapai nawabganj',
  'chapai nababganj': 'chapai nawabganj',
  'cox s bazar': "cox's bazar",
  coxsbazar: "cox's bazar",
  netrokona: 'netrakona',
  jhalakathi: 'jhalokati',
  maulvibazar: 'moulvibazar',
};

const fold = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface NamedPlace {
  readonly id: number;
  readonly nameEn: string;
  readonly nameBn: string;
}

/**
 * The district a free-text address names (D-556): ncom sends a city and a province, never the
 * courier's district and thana ids the ERP's orders need. Exact names first (English or
 * Bangla, a few old spellings), then a district named anywhere in the text; null when none.
 */
export function matchDistrict(
  texts: readonly (string | null | undefined)[],
  districts: readonly NamedPlace[],
): NamedPlace | null {
  const folded = texts.map((text) => fold(text ?? '')).filter((text) => text !== '');
  const canonical = (name: string): string => DISTRICT_ALIASES[name] ?? name;
  for (const text of folded) {
    const wanted = canonical(text);
    const exact = districts.find(
      (district) => fold(district.nameEn) === wanted || fold(district.nameBn) === wanted,
    );
    if (exact !== undefined) return exact;
  }
  const words = folded.join(' ');
  const expanded = ` ${words
    .split(' ')
    .map((word) => canonical(word))
    .join(' ')} `;
  // Longest names first, so "Chapai Nawabganj" wins over a shorter name inside it.
  const byLength = [...districts].sort((a, b) => b.nameEn.length - a.nameEn.length);
  return (
    byLength.find((district) => {
      const en = fold(district.nameEn);
      const bn = fold(district.nameBn);
      return (
        (en !== '' && expanded.includes(` ${en} `)) || (bn !== '' && expanded.includes(` ${bn} `))
      );
    }) ?? null
  );
}

/** The thana of a district the address text names, longest name first; null when none does. */
export function matchThana(
  texts: readonly (string | null | undefined)[],
  thanas: readonly NamedPlace[],
): NamedPlace | null {
  const words = ` ${texts.map((text) => fold(text ?? '')).join(' ')} `;
  const byLength = [...thanas].sort((a, b) => b.nameEn.length - a.nameEn.length);
  return (
    byLength.find((thana) => {
      const en = fold(thana.nameEn);
      const bn = fold(thana.nameBn);
      return (en !== '' && words.includes(` ${en} `)) || (bn !== '' && words.includes(` ${bn} `));
    }) ?? null
  );
}
