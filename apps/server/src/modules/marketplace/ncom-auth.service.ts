import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { NCOM_CONTRACT, ncomSecretEquals, verifyNcomSignature } from '@elysium/domain/storefront';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import { open, SealedBoxUnavailable } from '../../platform/crypto/sealed-box.js';
import { createLogger } from '../../platform/logging/logger.js';
import { STOREFRONT_API, type StorefrontApi } from '../storefront/storefront.api.js';
import * as repo from './marketplace.repository.js';
import { connectorError, header, ncomRawBodyOf, NcomRefusal } from './ncom.http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_LIMIT = 30;
const FLUSH_EVERY_MS = 60_000;

export interface Capabilities {
  readonly products: true;
  readonly stock: true;
  readonly search: boolean;
  readonly categories: boolean;
  readonly reserve: boolean;
  readonly release: boolean;
}

/** One authenticated connector call's brand and what it may do. */
export interface ConnectorContext {
  readonly orgId: string;
  readonly settings: repo.NcomSettingsRow;
  readonly capabilities: Capabilities;
  /** Where ncom's pages link products and categories to; empty when unknown. */
  readonly origin: string;
  readonly vendor: string;
}

/** An authenticated order handover's brand and the secret it was signed with. */
export interface OrderContext {
  readonly orgId: string;
  readonly settings: repo.NcomSettingsRow;
}

export function capabilitiesOf(settings: repo.NcomSettingsRow): Capabilities {
  return {
    products: true,
    stock: true,
    search: settings.allow_search,
    categories: settings.allow_categories,
    // One switch: a hold that cannot be returned is worse than no hold (the old site's rule).
    reserve: settings.allow_reserve,
    release: settings.allow_reserve,
  };
}

/**
 * Who is calling (M35b, D-553): ncom, for this brand, or nobody.
 *
 * **Nothing is trusted until the HMAC checks out.** The brand is in the path (the IPN's
 * arrangement: a request has no other way to name its tenant under FORCE RLS), the secret is
 * the brand's sealed one, and every failure — no secret, a foreign key id, a wrong or stale
 * signature — is the same 401 with the same sentence; the reason goes to the log and the
 * Marketplace screen only. A caller failing more than thirty times a minute still gets 401,
 * never 429 (a rotated secret looks exactly like that, and 401 is what tells ncom's dashboard
 * the key is wrong), with a `Retry-After` hint.
 */
@Injectable()
export class NcomAuthService {
  private cachedLogger: Logger | undefined;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly activity = new Map<
    string,
    {
      counts: Record<string, number>;
      lastKind: string | null;
      refusal: string | null;
      flushedAt: number;
    }
  >();

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('marketplace');
    return this.cachedLogger;
  }

  constructor(@Inject(STOREFRONT_API) private readonly storefront: StorefrontApi) {}

  /** A catalogue read or a hold: the connector's key id and secret. */
  async connector(orgIdParam: string, request: FastifyRequest): Promise<ConnectorContext> {
    const orgId = UUID.test(orgIdParam) ? orgIdParam : null;
    const loaded =
      orgId === null
        ? undefined
        : await withOrg({ orgId }, async (tx) => {
            const settings = await repo.settingsOf(tx, orgId);
            if (settings === undefined) return undefined;
            const site = await this.storefront.siteFacts(tx, orgId);
            return { settings, site };
          });
    if (orgId === null || loaded?.settings.connector_secret_sealed == null) {
      throw new NcomRefusal(
        401,
        connectorError('unauthorized', 'Product source is not connected.'),
      );
    }
    const { settings, site } = loaded;

    const contract = header(request, 'x-ncom-contract').trim();
    if (contract !== '' && contract !== NCOM_CONTRACT) {
      throw new NcomRefusal(
        400,
        connectorError(
          'unsupported_contract',
          `This connector implements contract ${NCOM_CONTRACT}, not ${contract.slice(0, 20)}.`,
        ),
      );
    }
    if (settings.connector_key_id !== '') {
      if (!ncomSecretEquals(header(request, 'x-ncom-key'), settings.connector_key_id)) {
        throw this.unauthorized(orgId, request, 'connector key mismatch');
      }
    }
    const secret = this.open(orgId, settings.connector_secret_sealed, 'connector_secret');
    if (secret === null) throw this.unauthorized(orgId, request, 'secret cannot be opened');
    const verdict = verifyNcomSignature(
      secret,
      ncomRawBodyOf(request),
      header(request, 'x-ncom-signature'),
      Date.now(),
    );
    if (!verdict.ok) throw this.unauthorized(orgId, request, verdict.reason);

    const origin = (
      settings.public_base_url !== '' ? settings.public_base_url : site.siteUrl
    ).replace(/\/+$/, '');
    return {
      orgId,
      settings,
      capabilities: capabilitiesOf(settings),
      origin: origin.startsWith('https://') ? origin : '',
      vendor: site.siteName,
    };
  }

  /** An order handed over: the order key id and secret, and the brand accepting orders. */
  async orders(orgIdParam: string, request: FastifyRequest): Promise<OrderContext> {
    const orgId = UUID.test(orgIdParam) ? orgIdParam : null;
    const settings =
      orgId === null ? undefined : await withOrg({ orgId }, (tx) => repo.settingsOf(tx, orgId));
    if (orgId === null || settings?.order_secret_sealed == null || settings.order_key_id === '') {
      throw new NcomRefusal(401, { error: 'Order intake is not configured' });
    }
    if (!settings.accept_orders) {
      throw new NcomRefusal(503, { error: 'This shop is not accepting ncom orders' });
    }
    if (!ncomSecretEquals(header(request, 'x-ncom-key'), settings.order_key_id)) {
      throw this.unauthorizedOrder(orgId, request, 'order key mismatch');
    }
    const secret = this.open(orgId, settings.order_secret_sealed, 'order_secret');
    if (secret === null) throw this.unauthorizedOrder(orgId, request, 'secret cannot be opened');
    const verdict = verifyNcomSignature(
      secret,
      ncomRawBodyOf(request),
      header(request, 'x-ncom-signature'),
      Date.now(),
    );
    if (!verdict.ok) throw this.unauthorizedOrder(orgId, request, verdict.reason);
    return { orgId, settings };
  }

  /** A webhook ncom delivered: its own secret. */
  async webhook(orgIdParam: string, request: FastifyRequest): Promise<OrderContext> {
    const orgId = UUID.test(orgIdParam) ? orgIdParam : null;
    const settings =
      orgId === null ? undefined : await withOrg({ orgId }, (tx) => repo.settingsOf(tx, orgId));
    if (orgId === null || settings?.webhook_secret_sealed == null) {
      throw new NcomRefusal(401, { error: 'Webhook secret not configured' });
    }
    const secret = this.open(orgId, settings.webhook_secret_sealed, 'webhook_secret');
    const verdict =
      secret === null
        ? ({ ok: false, reason: 'secret cannot be opened' } as const)
        : verifyNcomSignature(
            secret,
            ncomRawBodyOf(request),
            header(request, 'x-ncom-signature'),
            Date.now(),
          );
    if (!verdict.ok) {
      this.logger.warn({ reason: verdict.reason }, 'ncom webhook refused');
      this.note(orgId, null, `webhook: ${verdict.reason}`);
      throw new NcomRefusal(401, { error: 'Unauthorized' });
    }
    return { orgId, settings };
  }

  /** The secret the brand's order key signs with, for the outbox (D-556). */
  orderSecretOf(orgId: string, settings: repo.NcomSettingsRow): string | null {
    return this.open(orgId, settings.order_secret_sealed, 'order_secret');
  }

  private open(orgId: string, sealed: Buffer | null, field: string): string | null {
    if (sealed === null) return null;
    try {
      return open(sealed, { orgId, row: 'ncom_settings', field });
    } catch (error) {
      if (error instanceof SealedBoxUnavailable) return null;
      throw error;
    }
  }

  private unauthorized(orgId: string, request: FastifyRequest, reason: string): NcomRefusal {
    this.logger.warn({ reason }, 'ncom connector request refused');
    this.note(orgId, null, reason);
    const flooding = this.flooding(request);
    return new NcomRefusal(
      401,
      connectorError('unauthorized', 'Invalid signature.'),
      flooding ? { 'retry-after': '60' } : {},
    );
  }

  private unauthorizedOrder(orgId: string, request: FastifyRequest, reason: string): NcomRefusal {
    this.logger.warn({ reason }, 'ncom order refused');
    this.note(orgId, null, `orders: ${reason}`);
    const flooding = this.flooding(request);
    return new NcomRefusal(401, { error: 'Unauthorized' }, flooding ? { 'retry-after': '60' } : {});
  }

  private flooding(request: FastifyRequest): boolean {
    const now = Date.now();
    const key = request.ip;
    let entry = this.failures.get(key);
    if (entry === undefined || entry.resetAt <= now)
      entry = { count: 0, resetAt: now + FAILURE_WINDOW_MS };
    entry.count += 1;
    this.failures.set(key, entry);
    if (this.failures.size > 10_000) {
      for (const [ip, value] of this.failures) if (value.resetAt <= now) this.failures.delete(ip);
    }
    return entry.count > FAILURE_LIMIT;
  }

  /**
   * Count one served request (or a refusal) and, at most once a minute per brand, write the
   * tally: a database write on every cart a shopper opens is the cost this integration
   * exists to avoid.
   */
  async record(orgId: string, kind: string): Promise<void> {
    this.note(orgId, kind, null);
    await this.flush(orgId, false);
  }

  private note(orgId: string, kind: string | null, refusal: string | null): void {
    const entry = this.activity.get(orgId) ?? {
      counts: {},
      lastKind: null,
      refusal: null,
      flushedAt: 0,
    };
    const key = kind ?? 'refused';
    entry.counts[key] = (entry.counts[key] ?? 0) + 1;
    if (kind !== null) entry.lastKind = kind;
    if (refusal !== null) entry.refusal = refusal.slice(0, 200);
    this.activity.set(orgId, entry);
  }

  async flush(orgId: string, force: boolean): Promise<void> {
    const entry = this.activity.get(orgId);
    if (entry === undefined) return;
    if (!force && Date.now() - entry.flushedAt < FLUSH_EVERY_MS) return;
    const pending = { ...entry };
    this.activity.set(orgId, { counts: {}, lastKind: null, refusal: null, flushedAt: Date.now() });
    try {
      await withOrg({ orgId }, (tx) =>
        repo.recordActivity(tx, {
          orgId,
          counts: pending.counts,
          lastKind: pending.lastKind,
          refusal: pending.refusal,
        }),
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'ncom activity could not be recorded');
    }
  }
}
