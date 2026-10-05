import { maskEmail, maskPhone } from '../audit/index.js';
import { metaCity, metaName } from '../marketing/meta.js';
import { poishaToMajorNumber, type Poisha } from '../money/index.js';

/**
 * The website's tracking (M35b, D-552): the Meta pixel and Conversions API and Google
 * Analytics 4, ported from the old site's working `lib/tracking/*` (`hash.js`, `meta.js`,
 * `ga4.js`, `dispatch.js`, `constants.js`).
 *
 * The website forwards each browser event with the event id the browser fired it under; the
 * ERP's worker sends it to Meta's Conversions API and GA4's Measurement Protocol, and the ERP
 * itself fires the server-side `Purchase` when a website, landing-page or marketplace order is
 * placed (cash on delivery) or paid (SSLCommerz), under the old id `purchase_<order no>`, so a
 * browser event and a server event for one purchase are one purchase to Meta.
 *
 * Personal data is normalised and SHA-256 hashed **before anything is stored**, as Meta's
 * customer information parameters ask: the ERP keeps the hashes (sealed until sent), the
 * browser ids Meta takes in the clear, and a masked view for the log. The hash function is
 * injected, as M18's is (`marketing/meta.ts`), and the names and the city are normalised by
 * M18's own functions so both senders hash a buyer the same way.
 */

export const TRACKING_STANDARD_EVENTS = [
  'PageView',
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Purchase',
  'Search',
  'Lead',
  'CompleteRegistration',
] as const;
export type TrackingStandardEvent = (typeof TRACKING_STANDARD_EVENTS)[number];

/** Meta's event names, as GA4's recommended ones. */
export const GA4_EVENT_NAMES: Readonly<Record<TrackingStandardEvent, string>> = {
  PageView: 'page_view',
  ViewContent: 'view_item',
  AddToCart: 'add_to_cart',
  InitiateCheckout: 'begin_checkout',
  AddPaymentInfo: 'add_payment_info',
  Purchase: 'purchase',
  Search: 'search',
  Lead: 'generate_lead',
  CompleteRegistration: 'sign_up',
};

/** An event name the website may send: a standard one, or a custom word. */
export const TRACKING_EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** A Meta event name as GA4's; a custom name in snake case within GA4's characters. */
export function ga4EventName(name: string): string {
  const known = (GA4_EVENT_NAMES as Readonly<Record<string, string>>)[name];
  if (known !== undefined) return known;
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

/** Where one event goes: on at all, from the browser, from the server, to Meta, to GA4. */
export interface TrackingEventRoute {
  readonly name: string;
  readonly enabled: boolean;
  readonly client: boolean;
  readonly server: boolean;
  readonly meta: boolean;
  readonly ga4: boolean;
}

export function defaultEventRoute(name: string): TrackingEventRoute {
  return { name, enabled: true, client: true, server: true, meta: true, ga4: true };
}

/** The standard events, everything on: a new brand's routing. */
export function defaultEventRoutes(): TrackingEventRoute[] {
  return TRACKING_STANDARD_EVENTS.map((name) => defaultEventRoute(name));
}

/** An event's routing: its own row, or everything on for a custom event (the old rule). */
export function eventRouteFor(
  routes: readonly TrackingEventRoute[],
  name: string,
): TrackingEventRoute {
  return routes.find((route) => route.name === name) ?? defaultEventRoute(name);
}

/** What a brand's settings switch on, as the sender needs them. */
export interface TrackingSwitches {
  readonly capiEnabled: boolean;
  readonly capiReady: boolean;
  readonly mpEnabled: boolean;
  readonly mpReady: boolean;
}

/** Which of Meta and GA4 one server-side send goes to (the old `dispatchEvent`'s rule). */
export function trackingTargets(
  route: TrackingEventRoute,
  switches: TrackingSwitches,
): { readonly meta: boolean; readonly ga4: boolean } {
  const serverAllowed = route.enabled && route.server;
  return {
    meta: serverAllowed && route.meta && switches.capiEnabled && switches.capiReady,
    ga4: serverAllowed && route.ga4 && switches.mpEnabled && switches.mpReady,
  };
}

/** The shopper as the browser and the order know them. Raw: hashed by `metaUserData`. */
export interface TrackingUser {
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly zip?: string | undefined;
  readonly country?: string | undefined;
  readonly externalId?: string | undefined;
  /** Meta's browser ids, sent in the clear by Meta's specification. */
  readonly fbp?: string | undefined;
  readonly fbc?: string | undefined;
  readonly clientIpAddress?: string | undefined;
  readonly clientUserAgent?: string | undefined;
}

/** A SHA-256 hex digest of an already-normalised value (the caller's `node:crypto`). */
export type TrackingHash = (normalised: string) => string;

const lower = (value: string | undefined): string => (value ?? '').trim().toLowerCase();

/**
 * A phone as Meta matches it: digits with the country code (the old site's rule, BD-aware). A
 * local number's leading 0 becomes the default code; `00` is an international prefix.
 */
export function trackingPhone(phone: string | undefined, defaultCountryCode = '880'): string {
  let digits = (phone ?? '').replace(/[^0-9]/g, '');
  if (digits === '') return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) return `${defaultCountryCode}${digits.replace(/^0+/, '')}`;
  if (digits.length <= 10 && !digits.startsWith(defaultCountryCode)) {
    return `${defaultCountryCode}${digits}`;
  }
  return digits;
}

/** Meta's `user_data`: hashed identifiers, and the signals Meta takes in the clear. */
export type MetaUserData = Readonly<Record<string, string>>;

export function metaUserData(
  user: TrackingUser,
  hash: TrackingHash,
  defaultCountryCode = '880',
): MetaUserData {
  const out: Record<string, string> = {};
  const put = (key: string, normalised: string): void => {
    if (normalised !== '') out[key] = hash(normalised);
  };
  put('em', lower(user.email));
  put('ph', trackingPhone(user.phone, defaultCountryCode));
  put('fn', metaName(user.firstName ?? ''));
  put('ln', metaName(user.lastName ?? ''));
  put('ct', metaCity(user.city ?? ''));
  put('st', lower(user.state).replace(/[^a-z]/g, ''));
  put('zp', lower(user.zip).replace(/[^a-z0-9]/g, ''));
  const country = lower(user.country)
    .replace(/[^a-z]/g, '')
    .slice(0, 2);
  put('country', country);
  put('external_id', lower(user.externalId));
  if ((user.fbp ?? '') !== '') out.fbp = user.fbp ?? '';
  if ((user.fbc ?? '') !== '') out.fbc = user.fbc ?? '';
  if ((user.clientIpAddress ?? '') !== '') out.client_ip_address = user.clientIpAddress ?? '';
  if ((user.clientUserAgent ?? '') !== '') out.client_user_agent = user.clientUserAgent ?? '';
  return out;
}

/** Which of Meta's matching inputs an event carried: the log's match-quality view. */
export function trackingMatchKeys(user: TrackingUser): Readonly<Record<string, boolean>> {
  const has = (value: string | undefined): boolean => (value ?? '').trim() !== '';
  return {
    email: has(user.email),
    phone: has(user.phone),
    firstName: has(user.firstName),
    lastName: has(user.lastName),
    city: has(user.city),
    fbp: has(user.fbp),
    fbc: has(user.fbc),
    ip: has(user.clientIpAddress),
    userAgent: has(user.clientUserAgent),
    externalId: has(user.externalId),
  };
}

/** The log's view of the shopper: masked, never the address or number itself. */
export function trackingMaskedUser(user: TrackingUser): {
  readonly email: string;
  readonly phone: string;
} {
  return {
    email: (user.email ?? '') === '' ? '' : maskEmail(user.email ?? ''),
    phone: (user.phone ?? '') === '' ? '' : maskPhone(user.phone ?? ''),
  };
}

/** One item of `contents`, as the website and the order send it. */
export interface TrackingContent {
  readonly id: string;
  readonly quantity: number;
  readonly item_price?: number;
  readonly name?: string;
}

/**
 * The event's `custom_data`, bounded: the ecommerce fields the old site sent, and any other
 * scalar the website adds (a short string, a number, a flag), at most twenty of them.
 */
export type TrackingCustomData = Readonly<Record<string, unknown>>;

const MAX_CONTENTS = 50;
const MAX_EXTRA_KEYS = 20;
const KNOWN_KEYS = new Set([
  'value',
  'currency',
  'order_id',
  'search_string',
  'num_items',
  'contents',
  'items',
  'content_ids',
  'content_type',
  'content_name',
]);

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function finite(value: unknown): number | undefined {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** What the website sent as `customData`, cut to what may be stored and sent. */
export function boundedCustomData(input: unknown): Record<string, unknown> {
  const source = (input !== null && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};
  const value = finite(source.value);
  if (value !== undefined) out.value = value;
  const currency = text(source.currency, 3);
  if (currency !== undefined && /^[A-Z]{3}$/.test(currency)) out.currency = currency;
  for (const key of ['order_id', 'search_string', 'content_type', 'content_name'] as const) {
    const entry = text(source[key], 200);
    if (entry !== undefined) out[key] = entry;
  }
  const items = finite(source.num_items);
  if (items !== undefined) out.num_items = Math.trunc(items);
  if (Array.isArray(source.content_ids)) {
    out.content_ids = (source.content_ids as unknown[])
      .slice(0, MAX_CONTENTS)
      .map((id) =>
        typeof id === 'string' || typeof id === 'number' ? String(id).slice(0, 80) : '',
      )
      .filter((id) => id !== '');
  }
  const contents = Array.isArray(source.contents) ? source.contents : source.items;
  if (Array.isArray(contents)) {
    out.contents = (contents as unknown[]).slice(0, MAX_CONTENTS).flatMap((raw) => {
      const item = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const id = item.id ?? item.item_id ?? item.content_id;
      if (typeof id !== 'string' && typeof id !== 'number') return [];
      const entry: Record<string, unknown> = {
        id: String(id).slice(0, 80),
        quantity: Math.trunc(finite(item.quantity) ?? 1),
      };
      const price = finite(item.item_price ?? item.price);
      if (price !== undefined) entry.item_price = price;
      const name = text(item.name ?? item.item_name, 200);
      if (name !== undefined) entry.name = name;
      return [entry];
    });
  }
  let extra = 0;
  for (const [key, raw] of Object.entries(source)) {
    if (KNOWN_KEYS.has(key) || extra >= MAX_EXTRA_KEYS) continue;
    if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key)) continue;
    if (typeof raw === 'string') out[key] = raw.slice(0, 200);
    else if (typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else continue;
    extra += 1;
  }
  return out;
}

/** One event in Meta's `data` array (the old `buildMetaPayload`, one event at a time). */
export function metaEvent(input: {
  readonly eventName: string;
  readonly eventId: string;
  /** Unix seconds. */
  readonly eventTime: number;
  readonly eventSourceUrl?: string | undefined;
  readonly actionSource: string;
  readonly userData: MetaUserData;
  readonly customData: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {
    event_name: input.eventName,
    event_time: input.eventTime,
    action_source: input.actionSource,
    user_data: input.userData,
    event_id: input.eventId,
  };
  if ((input.eventSourceUrl ?? '') !== '') data.event_source_url = input.eventSourceUrl;
  if (Object.keys(input.customData).length > 0) data.custom_data = input.customData;
  return data;
}

/** `custom_data` as GA4's ecommerce parameters (the old `mapGa4Params`). */
export function ga4Params(customData: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof customData.value === 'number') out.value = customData.value;
  if (typeof customData.currency === 'string') out.currency = customData.currency;
  if (typeof customData.order_id === 'string') out.transaction_id = customData.order_id;
  if (typeof customData.search_string === 'string') out.search_term = customData.search_string;
  if (typeof customData.num_items === 'number') out.quantity = customData.num_items;
  if (Array.isArray(customData.contents)) {
    out.items = (customData.contents as Record<string, unknown>[]).map((item) => ({
      item_id: typeof item.id === 'string' ? item.id : '',
      item_name: typeof item.name === 'string' ? item.name : '',
      price: typeof item.item_price === 'number' ? item.item_price : 0,
      quantity: typeof item.quantity === 'number' ? item.quantity : 1,
    }));
  } else if (Array.isArray(customData.content_ids)) {
    out.items = (customData.content_ids as unknown[]).map((id) => ({ item_id: String(id) }));
  }
  for (const [key, value] of Object.entries(customData)) {
    if (KNOWN_KEYS.has(key) || value === null || typeof value === 'object') continue;
    out[key] = value;
  }
  return out;
}

/** One Measurement Protocol body (the old `buildGa4Payload`). */
export function ga4Payload(input: {
  readonly eventName: string;
  readonly eventId: string;
  /** The website's `_ga` client id, or the fallback the caller made. */
  readonly clientId: string;
  readonly sessionId?: string | undefined;
  readonly userId?: string | undefined;
  readonly customData: Readonly<Record<string, unknown>>;
  readonly extraParams?: Readonly<Record<string, unknown>> | undefined;
  readonly clientIp?: string | undefined;
  /** Unix seconds. */
  readonly eventTime: number;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    engagement_time_msec: 100,
    ...((input.sessionId ?? '') === '' ? {} : { session_id: input.sessionId }),
    event_id: input.eventId,
    ...((input.clientIp ?? '') === '' ? {} : { client_ip: input.clientIp }),
    ...ga4Params(input.customData),
    ...(input.extraParams ?? {}),
  };
  return {
    client_id: input.clientId,
    ...((input.userId ?? '') === '' ? {} : { user_id: input.userId }),
    timestamp_micros: input.eventTime * 1_000_000,
    events: [{ name: ga4EventName(input.eventName), params }],
  };
}

export type TrackingSendStatus = 'success' | 'error' | 'skipped';
export type TrackingStatus = 'success' | 'partial' | 'error' | 'skipped';

/** One status for an event from its two platforms' (the old `combineStatus`). */
export function combinedTrackingStatus(
  meta: TrackingSendStatus,
  ga4: TrackingSendStatus,
): TrackingStatus {
  const attempted = [meta, ga4].filter((status) => status !== 'skipped');
  if (attempted.length === 0) return 'skipped';
  if (attempted.every((status) => status === 'success')) return 'success';
  if (attempted.every((status) => status === 'error')) return 'error';
  return 'partial';
}

/** The browser and the server both name a purchase this way, so Meta keeps one of the two. */
export function purchaseEventId(orderNo: string): string {
  return `purchase_${orderNo}`;
}

/** An order's `Purchase`, as the old `trackPurchaseFromOrder` built it. */
export function purchaseCustomData(input: {
  readonly orderNo: string;
  readonly totalPoisha: Poisha;
  readonly lines: readonly {
    readonly productId: string;
    readonly name: string;
    readonly qty: number;
    readonly unitPricePoisha: Poisha;
  }[];
}): Record<string, unknown> {
  const contents = input.lines.map((line) => ({
    id: line.productId,
    quantity: line.qty,
    item_price: poishaToMajorNumber(line.unitPricePoisha),
    name: line.name,
  }));
  return {
    currency: 'BDT',
    value: poishaToMajorNumber(input.totalPoisha),
    order_id: input.orderNo,
    content_type: 'product',
    content_ids: contents.map((item) => item.id),
    contents,
    num_items: contents.reduce((total, item) => total + item.quantity, 0),
  };
}

/** A name split as the old site split it: the first word, and the rest. */
export function splitName(name: string): { readonly firstName: string; readonly lastName: string } {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') };
}

/** The log's retention, in days: at least one, at most a year (the old default 30). */
export function retentionDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, Math.trunc(days)));
}
