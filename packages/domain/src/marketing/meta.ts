import { sumDecimalsToPoisha, poishaToMajorNumber, type Poisha } from '../money/index.js';

/**
 * What crosses to Meta, decided here (architecture §11, §21; M18).
 *
 * Two of Meta's APIs, each built from its official documentation (read 2026-10-02) and
 * unverified until a brand's real credentials exist (D-257):
 *
 * - **Conversions API** (`/{pixel-id}/events`): one `Purchase` server event per delivered
 *   order. `event_id` is the order id, so a retry, a redelivered job or a pixel event with
 *   the same id is the same event to Meta (its documented deduplication key, with
 *   `event_name`). Customer identifiers are normalised exactly as Meta's "customer
 *   information parameters" page says and then SHA-256 hashed; the hash function is
 *   injected because this package has no `node:crypto`, and the caller's is the real one.
 * - **Insights** (`/act_{id}/insights`): `spend` arrives as a "numeric string", per ad and
 *   per day, in the ad account's currency and time zone. `aggregateMetaSpend` turns those
 *   rows into one figure per Meta campaign per day.
 *
 * Nothing here sends anything; the module's job does, outside every transaction.
 */

/** A SHA-256 hex digest of an already-normalised value. */
export type HashFn = (normalised: string) => string;

/**
 * A phone as Meta matches it: digits only, with the country code and no leading zeros.
 * `+8801712345678` → `8801712345678` (Meta's example: `16505551212`).
 */
export function metaPhone(e164: string): string {
  return e164.replace(/\D/g, '').replace(/^0+/, '');
}

/**
 * A first or last name: "lowercase only with no punctuation", UTF-8 kept.
 *
 * Letters and marks of any script survive, so a Bangla name is hashed as written; digits
 * and punctuation do not.
 */
export function metaName(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\s]/gu, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** A city: "lowercase only with no punctuation, no special characters, and no spaces". */
export function metaCity(value: string): string {
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}]/gu, '');
}

/** ISO 3166-1 alpha-2, lower-case, as Meta asks. Every order here ships within Bangladesh. */
export const META_COUNTRY = 'bd';

/**
 * Meta's event-time rule, from its server-event parameters page: "The `event_time` can be
 * up to 7 days before you send an event … If any `event_time` in `data` is greater than 7
 * days in the past, we return an error for the entire request." An hour is kept in hand
 * so an event right at the edge is not refused in flight.
 */
export const CAPI_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000;

export function capiEventTimeAllowed(eventTime: Date, now: Date): boolean {
  const age = now.getTime() - eventTime.getTime();
  return age <= CAPI_MAX_AGE_MS;
}

/**
 * Meta's `action_source`, by where the order was taken (D-256).
 *
 * Only values Meta documents. Messenger, Instagram and WhatsApp orders are taken in a chat;
 * a phone order on a call; a walk-in order in the showroom. Landing pages and the website
 * would be `website`, which Meta requires an `event_source_url` for — a URL an order does
 * not record — so they, TikTok and reseller orders are `other` until M29 records one.
 */
export type CapiActionSource = 'chat' | 'phone_call' | 'physical_store' | 'other';

export function capiActionSource(channel: string): CapiActionSource {
  switch (channel) {
    case 'facebook':
    case 'instagram':
    case 'whatsapp':
      return 'chat';
    case 'phone':
      return 'phone_call';
    case 'walk_in':
      return 'physical_store';
    default:
      return 'other';
  }
}

export interface PurchaseEventInput {
  readonly orderId: string;
  readonly customerId: string;
  readonly channel: string;
  /** When the parcel was delivered: the purchase completed then, for a COD order. */
  readonly deliveredAt: Date;
  /** Delivered net item value (§11: "value = delivered revenue"). */
  readonly valuePoisha: Poisha;
  readonly phoneE164: string;
  /** Sent only when `includeNameAndCity` (the brand records consent; D-256). */
  readonly name: string | null;
  readonly city: string | null;
  readonly includeNameAndCity: boolean;
  /** SKU codes and delivered quantities. Product ids, not personal data. */
  readonly contents: readonly { readonly id: string; readonly quantity: number }[];
}

/** One server event, in the shape Meta's `data` array takes. Hashes only, by construction. */
export interface CapiPurchaseEvent {
  readonly event_name: 'Purchase';
  readonly event_time: number;
  readonly event_id: string;
  readonly action_source: CapiActionSource;
  readonly user_data: {
    readonly ph: readonly string[];
    readonly country: readonly string[];
    readonly external_id: readonly string[];
    readonly fn?: readonly string[];
    readonly ln?: readonly string[];
    readonly ct?: readonly string[];
  };
  readonly custom_data: {
    readonly currency: 'BDT';
    readonly value: number;
    readonly order_id: string;
    readonly content_type: 'product';
    readonly contents: readonly { readonly id: string; readonly quantity: number }[];
  };
}

function hashed(hash: HashFn, normalised: string): readonly string[] {
  return normalised === '' ? [] : [hash(normalised)];
}

export function buildPurchaseEvent(input: PurchaseEventInput, hash: HashFn): CapiPurchaseEvent {
  const phone = metaPhone(input.phoneE164);
  if (phone === '') throw new Error('A conversion needs the buyer’s phone.');

  const optional: { fn?: readonly string[]; ln?: readonly string[]; ct?: readonly string[] } = {};
  if (input.includeNameAndCity) {
    const parts = metaName(input.name ?? '')
      .split(' ')
      .filter((part) => part !== '');
    const first = parts[0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
    const fn = hashed(hash, first);
    const ln = hashed(hash, last);
    const ct = hashed(hash, metaCity(input.city ?? ''));
    if (fn.length > 0) optional.fn = fn;
    if (ln.length > 0) optional.ln = ln;
    if (ct.length > 0) optional.ct = ct;
  }

  return {
    event_name: 'Purchase',
    event_time: Math.floor(input.deliveredAt.getTime() / 1000),
    event_id: input.orderId,
    action_source: capiActionSource(input.channel),
    user_data: {
      ph: [hash(phone)],
      country: [hash(META_COUNTRY)],
      // Meta recommends hashing `external_id`; our customer id is not personal data, and
      // hashing it keeps one rule for everything under `user_data`.
      external_id: [hash(input.customerId)],
      ...optional,
    },
    custom_data: {
      currency: 'BDT',
      value: poishaToMajorNumber(input.valuePoisha),
      order_id: input.orderId,
      content_type: 'product',
      contents: input.contents
        .filter((line) => line.quantity > 0)
        .map((line) => ({ id: line.id, quantity: line.quantity })),
    },
  };
}

/** One row of an ad-level, day-by-day Insights report, as the adapter parsed it. */
export interface MetaInsightRow {
  readonly campaignId: string;
  readonly campaignName: string;
  readonly adId: string | null;
  readonly accountCurrency: string;
  readonly dateStart: string;
  readonly dateStop: string;
  /** Meta's "numeric string". */
  readonly spend: string;
}

export interface MetaCampaignDay {
  readonly metaCampaignId: string;
  readonly campaignName: string;
  readonly spendOn: string;
  readonly amountPoisha: Poisha;
}

export interface AggregatedMetaSpend {
  readonly days: readonly MetaCampaignDay[];
  /** Every ad id seen per Meta campaign, so a click-to-message referral can be attributed. */
  readonly adsByCampaign: ReadonlyMap<string, readonly string[]>;
}

export class MetaSpendError extends Error {
  constructor(
    readonly reason: 'currency' | 'not_daily' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'MetaSpendError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One figure per Meta campaign per day, summed exactly from the ad-level rows.
 *
 * Refuses rather than guesses: a row in another currency (D-254: only BDT ad accounts
 * are imported until the client says how to convert), a row spanning more than one day
 * (the request asks for `time_increment=1`, so that is a response we did not ask for), or
 * a spend that is not a plain decimal.
 */
export function aggregateMetaSpend(rows: readonly MetaInsightRow[]): AggregatedMetaSpend {
  const groups = new Map<string, { row: MetaInsightRow; spends: string[] }>();
  const ads = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.accountCurrency.toUpperCase() !== 'BDT') {
      throw new MetaSpendError(
        'currency',
        `The ad account reports in ${row.accountCurrency}; only BDT accounts are imported.`,
      );
    }
    if (!ISO_DATE.test(row.dateStart) || row.dateStart !== row.dateStop) {
      throw new MetaSpendError('not_daily', 'Meta returned a row that is not a single day.');
    }
    if (row.campaignId.trim() === '') {
      throw new MetaSpendError('malformed', 'Meta returned a row with no campaign id.');
    }
    const key = `${row.campaignId}|${row.dateStart}`;
    const group = groups.get(key) ?? { row, spends: [] };
    group.spends.push(row.spend);
    groups.set(key, group);
    if (row.adId !== null && row.adId.trim() !== '') {
      const set = ads.get(row.campaignId) ?? new Set<string>();
      set.add(row.adId.trim());
      ads.set(row.campaignId, set);
    }
  }

  const days: MetaCampaignDay[] = [];
  for (const { row, spends } of groups.values()) {
    let amount: Poisha;
    try {
      amount = sumDecimalsToPoisha(spends);
    } catch {
      throw new MetaSpendError('malformed', 'Meta returned a spend that is not a number.');
    }
    days.push({
      metaCampaignId: row.campaignId,
      campaignName: row.campaignName,
      spendOn: row.dateStart,
      amountPoisha: amount,
    });
  }
  days.sort((a, b) =>
    a.spendOn === b.spendOn
      ? a.metaCampaignId.localeCompare(b.metaCampaignId)
      : a.spendOn.localeCompare(b.spendOn),
  );
  return {
    days,
    adsByCampaign: new Map([...ads].map(([campaign, set]) => [campaign, [...set].sort()])),
  };
}
