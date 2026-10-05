import { createHash, randomInt } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { TrackingEventsRequest, TrackingSettingsInput } from '@elysium/contracts';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { decimalToPoisha, poisha } from '@elysium/domain';
import {
  boundedCustomData,
  combinedTrackingStatus,
  defaultEventRoutes,
  eventRouteFor,
  ga4Payload,
  metaEvent,
  metaUserData,
  purchaseCustomData,
  purchaseEventId,
  retentionDays,
  splitName,
  trackingMaskedUser,
  trackingMatchKeys,
  trackingTargets,
  type MetaUserData,
  type TrackingEventRoute,
  type TrackingUser,
} from '@elysium/domain/storefront';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { ActiveContext } from '../../platform/http/context.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import {
  open,
  seal,
  sealedBoxConfigured,
  SealedBoxUnavailable,
} from '../../platform/crypto/sealed-box.js';
import { StorefrontError } from './storefront.errors.js';
import { STOREFRONT_QUEUES } from './storefront.queues.js';
import { STOREFRONT_RATE_LIMITER } from './signature.guard.js';
import { TRACKING_GATEWAY, type PlatformResult, type TrackingGateway } from './tracking.gateway.js';
import * as repo from './web-marketing.repository.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Meta's window for a server event's time: seven days back, an hour kept in hand. */
const MAX_EVENT_AGE_SECONDS = 7 * 24 * 3600 - 3600;
/** Browser events one shopper may forward a minute (the old site's 120). */
const EVENTS_PER_MINUTE = 120;

const DEFAULT_PROXY = {
  metaScriptPath: '/e1/s.js',
  metaCollectPath: '/e1/t',
  ga4ScriptPath: '/e2/s.js',
  ga4CollectPath: '/e2',
} as const;

/** What is sealed until an event is sent: everything personal, already hashed where it can be. */
interface SealedPayload {
  readonly userData: MetaUserData;
  readonly eventTime: number;
  readonly eventSourceUrl: string | null;
  readonly actionSource: string;
  readonly ga4: {
    readonly clientId: string;
    readonly sessionId: string | null;
    readonly userId: string | null;
    readonly params: Readonly<Record<string, unknown>>;
  };
  readonly clientIp: string | null;
  readonly userAgent: string | null;
}

/** An order's purchase, as the module that placed it knows it (D-552). */
export interface PurchaseFacts {
  readonly orderId: string;
  readonly orderNo: string;
  readonly totalPoisha: bigint;
  readonly lines: readonly {
    readonly productId: string;
    readonly name: string;
    readonly qty: number;
    readonly unitPricePoisha: bigint;
  }[];
  readonly buyer: {
    readonly name: string;
    readonly phoneE164: string;
    readonly email: string | null;
    readonly city: string | null;
    readonly customerId: string;
  };
  readonly browser?:
    | {
        readonly fbp?: string | undefined;
        readonly fbc?: string | undefined;
        readonly eventSourceUrl?: string | undefined;
        readonly gaClientId?: string | undefined;
        readonly gaSessionId?: string | undefined;
      }
    | undefined;
  readonly client?:
    { readonly ip?: string | undefined; readonly userAgent?: string | undefined } | undefined;
  /** Paid online: logged now, sent once the payment is booked (`releasePurchase`). */
  readonly waitForPayment: boolean;
}

interface Settings {
  readonly row: repo.TrackingSettingsRow | undefined;
  readonly routes: readonly TrackingEventRoute[];
}

function routesOf(value: unknown): TrackingEventRoute[] {
  if (!Array.isArray(value)) return defaultEventRoutes();
  return (value as unknown[]).flatMap((entry) => {
    const route = entry as Partial<TrackingEventRoute> | null;
    if (route === null || typeof route.name !== 'string') return [];
    return [
      {
        name: route.name,
        enabled: route.enabled !== false,
        client: route.client !== false,
        server: route.server !== false,
        meta: route.meta !== false,
        ga4: route.ga4 !== false,
      },
    ];
  });
}

function proxyOf(value: unknown): Record<keyof typeof DEFAULT_PROXY, string> {
  const given = (value !== null && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof typeof DEFAULT_PROXY, unknown>
  >;
  const pick = (key: keyof typeof DEFAULT_PROXY): string =>
    typeof given[key] === 'string' && given[key] !== ''
      ? (given[key] as string)
      : DEFAULT_PROXY[key];
  return {
    metaScriptPath: pick('metaScriptPath'),
    metaCollectPath: pick('metaCollectPath'),
    ga4ScriptPath: pick('ga4ScriptPath'),
    ga4CollectPath: pick('ga4CollectPath'),
  };
}

const SKIPPED = { status: 'skipped' } as const;

/**
 * The website's tracking (M35b, D-552): settings, the browser events the website forwards,
 * the ERP's own `Purchase`, and the sends.
 *
 * Every external call is the worker's (`storefront.tracking_send`, invariant 6); requests only
 * write the log row, with what is to be sent sealed (`STOREFRONT_CREDENTIALS_KEY`, D-528's box)
 * and personal data already hashed. Without a key nothing personal can be kept, so events are
 * answered `skipped` and nothing is stored.
 */
@Injectable()
export class TrackingService {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('storefront');
    return this.cachedLogger;
  }

  constructor(
    @Inject(TRACKING_GATEWAY) private readonly gateway: TrackingGateway,
    @Inject(STOREFRONT_RATE_LIMITER) private readonly limiter: RateLimitStore,
  ) {}

  // --- the console ----------------------------------------------------------------------------

  async settings(context: ActiveContext) {
    return withOrg(context, async (tx) =>
      this.view(await repo.trackingSettings(tx, context.orgId)),
    );
  }

  async save(context: ActiveContext, input: TrackingSettingsInput) {
    const wantsSecret =
      typeof input.meta.accessToken === 'string' || typeof input.ga4.apiSecret === 'string';
    if (wantsSecret && !sealedBoxConfigured()) {
      throw new StorefrontError(
        'WEBSITE_CREDENTIALS_MISSING',
        HttpStatus.CONFLICT,
        'This server has no STOREFRONT_CREDENTIALS_KEY, so the access token and the API secret cannot be kept.',
      );
    }
    return withOrg(context, async (tx) => {
      const bind = (field: string) => ({ orgId: context.orgId, row: 'tracking_settings', field });
      const token =
        typeof input.meta.accessToken === 'string'
          ? seal(input.meta.accessToken, bind('meta_token'))
          : input.meta.accessToken;
      const secret =
        typeof input.ga4.apiSecret === 'string'
          ? seal(input.ga4.apiSecret, bind('ga4_secret'))
          : input.ga4.apiSecret;
      const keyId =
        token !== null && token !== undefined
          ? token.keyId
          : secret !== null && secret !== undefined
            ? secret.keyId
            : null;
      await repo.upsertTrackingSettings(tx, {
        orgId: context.orgId,
        metaPixelEnabled: input.meta.pixelEnabled,
        metaCapiEnabled: input.meta.capiEnabled,
        metaPixelId: input.meta.pixelId,
        metaDatasetId: input.meta.datasetId,
        metaApiVersion: input.meta.apiVersion,
        metaTestEventCode: input.meta.testEventCode,
        defaultCountryCode: input.meta.defaultCountryCode,
        ga4ClientEnabled: input.ga4.clientEnabled,
        ga4MpEnabled: input.ga4.mpEnabled,
        ga4MeasurementId: input.ga4.measurementId,
        proxy: input.proxy,
        testMode: input.testMode,
        events: input.events,
        logRetentionDays: retentionDays(input.logRetentionDays),
        metaToken:
          token === undefined || token === null
            ? token
            : { sealed: token.ciphertext, fingerprint: token.fingerprint },
        ga4Secret:
          secret === undefined || secret === null
            ? secret
            : { sealed: secret.ciphertext, fingerprint: secret.fingerprint },
        keyId,
        updatedBy: context.userId,
      });
      return this.view(await repo.trackingSettings(tx, context.orgId));
    });
  }

  /** The log, newest first, a page at a time. Masked people, never a hash or a payload. */
  async eventLog(
    context: ActiveContext,
    query: {
      readonly status?: string;
      readonly eventName?: string;
      readonly cursor?: string;
      readonly limit: number;
    },
  ) {
    const before = decodeCursor(query.cursor);
    return withOrg(context, async (tx) => {
      const rows = await repo.trackingEvents(tx, context.orgId, {
        status: query.status,
        eventName: query.eventName,
        limit: query.limit + 1,
        before,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          eventName: row.event_name,
          source: row.source,
          testMode: row.test_mode,
          orderId: row.order_id,
          user: row.user_masked,
          matchKeys: row.match_keys,
          value: row.value_poisha === null ? null : String(row.value_poisha),
          currency: row.currency,
          status: row.status,
          meta: row.meta,
          ga4: row.ga4,
          attempts: row.attempts,
          sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
          createdAt: new Date(row.created_at).toISOString(),
        })),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? Buffer.from(
                JSON.stringify([new Date(last.created_at).toISOString(), last.id]),
              ).toString('base64url')
            : null,
        stats: await repo.trackingStats(tx, context.orgId),
      };
    });
  }

  private view(row: repo.TrackingSettingsRow | undefined) {
    return {
      settings: {
        meta: {
          pixelEnabled: row?.meta_pixel_enabled ?? false,
          capiEnabled: row?.meta_capi_enabled ?? false,
          pixelId: row?.meta_pixel_id ?? '',
          datasetId: row?.meta_dataset_id ?? '',
          apiVersion: row?.meta_api_version ?? 'v21.0',
          accessTokenSet: row?.meta_token_fingerprint != null,
          accessTokenFingerprint: row?.meta_token_fingerprint ?? null,
          testEventCode: row?.meta_test_event_code ?? '',
          defaultCountryCode: row?.default_country_code ?? '880',
        },
        ga4: {
          clientEnabled: row?.ga4_client_enabled ?? false,
          mpEnabled: row?.ga4_mp_enabled ?? false,
          measurementId: row?.ga4_measurement_id ?? '',
          apiSecretSet: row?.ga4_secret_fingerprint != null,
          apiSecretFingerprint: row?.ga4_secret_fingerprint ?? null,
        },
        proxy: proxyOf(row?.proxy),
        testMode: row?.test_mode ?? false,
        events: row === undefined ? defaultEventRoutes() : routesOf(row.events),
        logRetentionDays: row?.log_retention_days ?? 30,
        updatedAt: row === undefined ? null : new Date(row.updated_at).toISOString(),
      },
      provider: this.gateway.provider,
      credentialsKey: sealedBoxConfigured(),
    };
  }

  // --- the website ----------------------------------------------------------------------------

  /** What the browser's helper needs: the pixel, the measurement id, the paths. No secret. */
  async clientConfig(orgId: string) {
    return withOrg({ orgId }, async (tx) => {
      const row = await repo.trackingSettings(tx, orgId);
      const routes = row === undefined ? defaultEventRoutes() : routesOf(row.events);
      return {
        tracking: {
          meta: {
            pixelEnabled: row?.meta_pixel_enabled ?? false,
            pixelId: row?.meta_pixel_id ?? '',
          },
          ga4: {
            clientEnabled: row?.ga4_client_enabled ?? false,
            measurementId: row?.ga4_measurement_id ?? '',
          },
          proxy: proxyOf(row?.proxy),
          testMode: row?.test_mode ?? false,
          events: routes.map((route) => ({
            name: route.name,
            enabled: route.enabled,
            client: route.client,
          })),
        },
      };
    });
  }

  /**
   * Browser events the website forwards (the old `/api/events`): each one logged and queued
   * for the worker, or answered `skipped` when the brand sends nothing server-side for it.
   * Always the browser's source: a caller cannot label an event as the server's.
   */
  async ingest(orgId: string, input: TrackingEventsRequest) {
    if (input.client !== undefined) {
      const decision = await this.limiter.hit(
        `storefront:events:${orgId}:${input.client.ip}`,
        EVENTS_PER_MINUTE,
        60,
      );
      if (!decision.allowed) {
        throw new StorefrontError(
          'RATE_LIMITED',
          HttpStatus.TOO_MANY_REQUESTS,
          'Too many events from this shopper. Wait a minute.',
          decision.retryAfterSeconds ?? 60,
        );
      }
    }
    const now = Math.floor(Date.now() / 1000);
    return withOrg({ orgId }, async (tx) => {
      const settings = await this.settingsOf(tx, orgId);
      const results: { eventId: string; status: 'queued' | 'skipped' }[] = [];
      for (const event of input.events) {
        const eventId = event.eventId ?? `${event.eventName.toLowerCase()}_${randomId()}`;
        const eventTime = Math.min(event.eventTime ?? now, now);
        const sendable = this.sendable(settings, event.eventName) && sealedBoxConfigured();
        if (!sendable || now - eventTime > MAX_EVENT_AGE_SECONDS) {
          results.push({ eventId, status: 'skipped' });
          continue;
        }
        const user: TrackingUser = {
          ...(event.userData ?? {}),
          clientIpAddress: input.client?.ip,
          clientUserAgent: input.client?.userAgent,
        };
        const customData = boundedCustomData(event.customData);
        await this.log(tx, orgId, settings, {
          eventId,
          eventName: event.eventName,
          source: 'client',
          orderId: null,
          user,
          customData,
          payload: {
            eventTime,
            eventSourceUrl: event.eventSourceUrl ?? null,
            actionSource: event.actionSource ?? 'website',
            ga4: {
              clientId: event.ga4?.clientId ?? fallbackClientId(),
              sessionId: event.ga4?.sessionId ?? null,
              userId: event.ga4?.userId ?? null,
              params: event.ga4?.params ?? {},
            },
          },
          waiting: false,
        });
        results.push({ eventId, status: 'queued' });
      }
      return { ok: true, results };
    });
  }

  /**
   * The ERP's own `Purchase` for an order it placed (D-552), in the placing transaction:
   * `purchase_<order no>`, the id the website's confirmation page fires the browser's with, so
   * Meta keeps one of the two. Logged once per order however often it is asked; for an order
   * paid online it waits for the payment (`releasePurchase`).
   */
  async recordPurchase(tx: Tx, orgId: string, facts: PurchaseFacts): Promise<void> {
    const settings = await this.settingsOf(tx, orgId);
    if (!this.sendable(settings, 'Purchase') || !sealedBoxConfigured()) return;
    const { firstName, lastName } = splitName(facts.buyer.name);
    const user: TrackingUser = {
      ...(facts.buyer.email === null ? {} : { email: facts.buyer.email }),
      phone: facts.buyer.phoneE164,
      firstName,
      lastName,
      ...(facts.buyer.city === null ? {} : { city: facts.buyer.city }),
      country: 'BD',
      externalId: facts.buyer.customerId,
      fbp: facts.browser?.fbp,
      fbc: facts.browser?.fbc,
      clientIpAddress: facts.client?.ip,
      clientUserAgent: facts.client?.userAgent,
    };
    const customData = purchaseCustomData({
      orderNo: facts.orderNo,
      totalPoisha: poisha(facts.totalPoisha),
      lines: facts.lines.map((line) => ({
        productId: line.productId,
        name: line.name,
        qty: line.qty,
        unitPricePoisha: poisha(line.unitPricePoisha),
      })),
    });
    await this.log(tx, orgId, settings, {
      eventId: purchaseEventId(facts.orderNo),
      eventName: 'Purchase',
      source: 'server',
      orderId: facts.orderId,
      user,
      customData,
      valuePoisha: facts.totalPoisha,
      payload: {
        eventTime: Math.floor(Date.now() / 1000),
        eventSourceUrl: facts.browser?.eventSourceUrl ?? null,
        actionSource: 'website',
        ga4: {
          clientId: facts.browser?.gaClientId ?? fallbackClientId(),
          sessionId: facts.browser?.gaSessionId ?? null,
          userId: facts.buyer.customerId,
          params: {},
        },
      },
      waiting: facts.waitForPayment,
    });
  }

  /** An online payment was booked: its order's waiting `Purchase` goes now. */
  async releasePurchase(tx: Tx, orgId: string, orderId: string): Promise<void> {
    const waiting = await repo.waitingPurchase(tx, orgId, orderId);
    if (waiting === undefined) return;
    await repo.markTrackingQueued(tx, orgId, waiting.id);
    await enqueue(
      tx,
      STOREFRONT_QUEUES.trackingSend.name,
      { eventId: waiting.id },
      { orgId, ref: waiting.id, singletonKey: `tracking:${waiting.id}` },
    );
  }

  private async log(
    tx: Tx,
    orgId: string,
    settings: Settings,
    entry: {
      readonly eventId: string;
      readonly eventName: string;
      readonly source: 'client' | 'server';
      readonly orderId: string | null;
      readonly user: TrackingUser;
      readonly customData: Record<string, unknown>;
      readonly valuePoisha?: bigint;
      readonly payload: Omit<SealedPayload, 'userData' | 'clientIp' | 'userAgent'>;
      readonly waiting: boolean;
    },
  ): Promise<void> {
    const row = settings.row;
    const payload: SealedPayload = {
      ...entry.payload,
      userData: metaUserData(entry.user, sha256, row?.default_country_code ?? '880'),
      clientIp: entry.user.clientIpAddress ?? null,
      userAgent: entry.user.clientUserAgent ?? null,
    };
    const sealed = seal(JSON.stringify(payload), {
      orgId,
      row: `tracking_event:${entry.eventId}`,
      field: 'payload',
    });
    const value = entry.valuePoisha ?? valueOf(entry.customData.value);
    const id = await repo.insertTrackingEvent(tx, {
      orgId,
      eventId: entry.eventId,
      eventName: entry.eventName,
      source: entry.source,
      testMode: row?.test_mode ?? false,
      orderId: entry.orderId,
      userMasked: trackingMaskedUser(entry.user),
      matchKeys: trackingMatchKeys(entry.user),
      customData: entry.customData,
      valuePoisha: value !== null && value >= 0n ? value : null,
      currency: typeof entry.customData.currency === 'string' ? entry.customData.currency : null,
      payload: { sealed: sealed.ciphertext, keyId: sealed.keyId },
      status: entry.waiting ? 'waiting' : 'queued',
      retentionDays: retentionDays(row?.log_retention_days ?? 30),
    });
    if (id === null || entry.waiting) return;
    await enqueue(
      tx,
      STOREFRONT_QUEUES.trackingSend.name,
      { eventId: id },
      { orgId, ref: id, singletonKey: `tracking:${id}` },
    );
  }

  /** Whether this event could go anywhere server-side for this brand now. */
  private sendable(settings: Settings, eventName: string): boolean {
    const row = settings.row;
    if (row === undefined) return false;
    const route = eventRouteFor(settings.routes, eventName);
    const targets = trackingTargets(route, {
      capiEnabled: row.meta_capi_enabled,
      capiReady: row.meta_pixel_id !== '' && row.meta_token_sealed !== null,
      mpEnabled: row.ga4_mp_enabled,
      mpReady: row.ga4_measurement_id !== '' && row.ga4_secret_sealed !== null,
    });
    return targets.meta || targets.ga4;
  }

  private async settingsOf(tx: Tx, orgId: string): Promise<Settings> {
    const row = await repo.trackingSettings(tx, orgId);
    return { row, routes: row === undefined ? defaultEventRoutes() : routesOf(row.events) };
  }

  // --- the worker -----------------------------------------------------------------------------

  /**
   * Send one logged event to Meta and GA4 (the old `dispatchEvent`), with no transaction open
   * while the platforms are called. A row already sent, or no longer queued, is left alone.
   */
  async send(orgId: string, rowId: string): Promise<void> {
    const prepared = await withOrg({ orgId }, async (tx) => {
      const row = await repo.trackingEventForUpdate(tx, orgId, rowId);
      if (row?.status !== 'queued') return null;
      const settings = await this.settingsOf(tx, orgId);
      return { row, settings };
    });
    if (prepared === null) return;
    const { row, settings } = prepared;

    let meta: Record<string, unknown> = { ...SKIPPED };
    let ga4: Record<string, unknown> = { ...SKIPPED };
    try {
      const plan = this.plan(orgId, row, settings);
      const metaSend = plan.meta;
      const ga4Send = plan.ga4;
      if (metaSend !== null) meta = summary(await retryOnce(() => this.gateway.sendMeta(metaSend)));
      if (ga4Send !== null) ga4 = summary(await retryOnce(() => this.gateway.sendGa4(ga4Send)));
    } catch (error) {
      if (!(error instanceof SealedBoxUnavailable)) throw error;
      // A payload or a secret this installation cannot open: recorded, never retried.
      this.logger.warn({ eventRow: rowId }, 'a tracked event could not be opened to send');
      meta = { status: 'error', error: 'The credentials could not be opened on this server.' };
    }
    const status = combinedTrackingStatus(
      meta.status as 'success' | 'error' | 'skipped',
      ga4.status as 'success' | 'error' | 'skipped',
    );
    await withOrg({ orgId }, (tx) =>
      repo.recordTrackingResult(tx, { orgId, id: rowId, status, meta, ga4 }),
    );
  }

  private plan(orgId: string, row: repo.TrackingEventRow, settings: Settings) {
    const config = settings.row;
    if (config === undefined || row.payload_sealed === null) return { meta: null, ga4: null };
    const payload = JSON.parse(
      open(row.payload_sealed, {
        orgId,
        row: `tracking_event:${row.event_id}`,
        field: 'payload',
      }),
    ) as SealedPayload;
    const route = eventRouteFor(settings.routes, row.event_name);
    const targets = trackingTargets(route, {
      capiEnabled: config.meta_capi_enabled,
      capiReady: config.meta_pixel_id !== '' && config.meta_token_sealed !== null,
      mpEnabled: config.ga4_mp_enabled,
      mpReady: config.ga4_measurement_id !== '' && config.ga4_secret_sealed !== null,
    });
    const bind = (field: string) => ({ orgId, row: 'tracking_settings', field });
    const customData = (row.custom_data ?? {}) as Record<string, unknown>;
    return {
      meta:
        targets.meta && config.meta_token_sealed !== null
          ? {
              apiVersion: config.meta_api_version,
              target: config.meta_dataset_id !== '' ? config.meta_dataset_id : config.meta_pixel_id,
              token: open(config.meta_token_sealed, bind('meta_token')),
              event: metaEvent({
                eventName: row.event_name,
                eventId: row.event_id,
                eventTime: payload.eventTime,
                eventSourceUrl: payload.eventSourceUrl ?? undefined,
                actionSource: payload.actionSource,
                userData: payload.userData,
                customData,
              }),
              testEventCode:
                row.test_mode && config.meta_test_event_code !== ''
                  ? config.meta_test_event_code
                  : null,
            }
          : null,
      ga4:
        targets.ga4 && config.ga4_secret_sealed !== null
          ? {
              measurementId: config.ga4_measurement_id,
              apiSecret: open(config.ga4_secret_sealed, bind('ga4_secret')),
              payload: ga4Payload({
                eventName: row.event_name,
                eventId: row.event_id,
                clientId: payload.ga4.clientId,
                sessionId: payload.ga4.sessionId ?? undefined,
                userId: payload.ga4.userId ?? undefined,
                customData,
                extraParams: payload.ga4.params,
                clientIp: payload.clientIp ?? undefined,
                eventTime: payload.eventTime,
              }),
              userAgent: payload.userAgent,
              debug: row.test_mode,
            }
          : null,
    };
  }

  /** The nightly purge: every brand's events past their retention (D-552). */
  async purgeAll(): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.organizations order by slug`,
      );
      return [...rows].map((row) => row.id);
    });
    let removed = 0;
    for (const orgId of orgIds) {
      removed += await withOrg({ orgId }, (tx) => repo.purgeTrackingEvents(tx, orgId));
    }
    return removed;
  }
}

/** The old dispatcher's one retry, after 300 ms, for an answer that a retry could change. */
async function retryOnce(send: () => Promise<PlatformResult>): Promise<PlatformResult> {
  const first = await send();
  if (first.status === 'success' || !first.retryable) return first;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return send();
}

function summary(result: PlatformResult): Record<string, unknown> {
  return {
    status: result.status,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    error: result.error,
    ...result.detail,
  };
}

/** The browser's `value` as poisha, when it is a plain amount; nothing otherwise. */
function valueOf(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  try {
    return decimalToPoisha(String(value));
  } catch {
    return null;
  }
}

function randomId(): string {
  return `${Date.now().toString(36)}${randomInt(0, 2 ** 31 - 1).toString(36)}`;
}

/** GA4 needs a client id; a browser that sent none gets the old site's made-up one. */
function fallbackClientId(): string {
  return `${String(Math.floor(Date.now() / 1000))}.${String(randomInt(0, 1_000_000_000))}`;
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed[1]) &&
      !Number.isNaN(Date.parse(parsed[0]))
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    return null;
  }
  return null;
}
