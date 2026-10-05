import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { MarketplaceSettingsInput } from '@elysium/contracts';
import { withOrg } from '@elysium/db';

import { seal, sealedBoxConfigured } from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { serverEnv } from '../../platform/config/env.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import * as repo from './marketplace.repository.js';

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function refusal(code: string, status: number, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

/**
 * Website → Marketplace (M35b, D-553): the ncom.bd connection, what ncom has done lately, the
 * holds it has open and the orders it handed over with what was sent back.
 *
 * Reading is `read Storefront`; changing the connection is `update WebsiteCredentials`, org_admin
 * only, as M34 decided for SSLCommerz (D-528): these secrets let ncom take orders and hold stock.
 * The four secrets are sealed, write-only and shown as fingerprints.
 */
@Injectable()
export class MarketplaceSettingsService {
  constructor(
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(ORDERS_API) private readonly ordersApi: OrdersApi,
  ) {}

  async view(context: ActiveContext) {
    return withOrg(context, async (tx) => {
      const row = await repo.settingsOf(tx, context.orgId);
      const base = serverEnv().API_PUBLIC_URL.replace(/\/+$/, '');
      const prefix = `${base}/ncom/${context.orgId}`;
      return {
        settings: {
          enabled: row?.enabled ?? false,
          acceptOrders: row?.accept_orders ?? false,
          includeDrafts: row?.include_drafts ?? true,
          allowSearch: row?.allow_search ?? true,
          allowCategories: row?.allow_categories ?? true,
          allowReserve: row?.allow_reserve ?? true,
          defaultWeightGrams: row?.default_weight_grams ?? 0,
          publicBaseUrl: row?.public_base_url ?? '',
          baseUrl: row?.base_url ?? 'https://ncom.bd/api/v1',
          connectorKeyId: row?.connector_key_id ?? '',
          orderKeyId: row?.order_key_id ?? '',
          connectorSecretFingerprint: row?.connector_secret_fingerprint ?? null,
          orderSecretFingerprint: row?.order_secret_fingerprint ?? null,
          apiKeyFingerprint: row?.api_key_fingerprint ?? null,
          webhookSecretFingerprint: row?.webhook_secret_fingerprint ?? null,
        },
        addresses: {
          connector: `${prefix}/v1`,
          orders: `${prefix}/orders`,
          webhook: `${prefix}/webhook`,
        },
        activity: {
          lastRequestAt: iso(row?.last_request_at ?? null),
          lastRequestKind: row?.last_request_kind ?? null,
          requestCounts: row?.request_counts ?? {},
          lastRefusalReason: row?.last_refusal_reason ?? null,
          lastRefusalAt: iso(row?.last_refusal_at ?? null),
          lastOrderAt: iso(row?.last_order_at ?? null),
          ordersReceived: row?.orders_received ?? 0,
          lastWebhookAt: iso(row?.last_webhook_at ?? null),
        },
        credentialsKey: sealedBoxConfigured(),
      };
    });
  }

  async save(context: ActiveContext, input: MarketplaceSettingsInput) {
    const setting = [input.connectorSecret, input.orderSecret, input.apiKey, input.webhookSecret];
    if (setting.some((value) => typeof value === 'string') && !sealedBoxConfigured()) {
      throw refusal(
        'WEBSITE_CREDENTIALS_MISSING',
        HttpStatus.CONFLICT,
        'This server has no STOREFRONT_CREDENTIALS_KEY, so the marketplace secrets cannot be kept.',
      );
    }
    await withOrg(context, async (tx) => {
      let keyId: string | null = null;
      const sealOne = (value: string | null | undefined, field: string) => {
        if (typeof value !== 'string') return value;
        const sealed = seal(value, { orgId: context.orgId, row: 'ncom_settings', field });
        keyId = sealed.keyId;
        return { sealed: sealed.ciphertext, fingerprint: sealed.fingerprint };
      };
      const secrets = {
        connector_secret: sealOne(input.connectorSecret, 'connector_secret'),
        order_secret: sealOne(input.orderSecret, 'order_secret'),
        api_key: sealOne(input.apiKey, 'api_key'),
        webhook_secret: sealOne(input.webhookSecret, 'webhook_secret'),
      };
      await repo.upsertSettings(tx, {
        orgId: context.orgId,
        enabled: input.enabled,
        acceptOrders: input.acceptOrders,
        includeDrafts: input.includeDrafts,
        allowSearch: input.allowSearch,
        allowCategories: input.allowCategories,
        allowReserve: input.allowReserve,
        defaultWeightGrams: input.defaultWeightGrams,
        publicBaseUrl: input.publicBaseUrl,
        baseUrl: input.baseUrl,
        connectorKeyId: input.connectorKeyId,
        orderKeyId: input.orderKeyId,
        secrets,
        keyId,
        updatedBy: context.userId,
      });
    });
    return this.view(context);
  }

  /** Holds ncom has taken, newest first; open ones are units the website cannot sell. */
  async holds(context: ActiveContext, state: 'held' | 'released' | 'converted' | undefined) {
    return withOrg(context, async (tx) => ({
      items: (await repo.holds(tx, context.orgId, state, 200)).map((row) => ({
        id: row.id,
        orderRef: row.order_ref,
        state: row.state,
        locationId: row.location_id,
        lines: row.lines,
        heldAt: iso(row.held_at),
        releasedAt: iso(row.released_at),
        convertedOrderId: row.converted_order_id,
      })),
    }));
  }

  /**
   * Give back a hold ncom never released (D-553: a hold is not a sale; one left open when the
   * brand does not take ncom's orders is a person's to release). Exactly what it held, once.
   */
  async releaseHold(context: ActiveContext, id: string) {
    return withOrg(context, async (tx) => {
      const hold = await repo.holdById(tx, context.orgId, id);
      if (hold === undefined) {
        throw refusal('NOT_FOUND', HttpStatus.NOT_FOUND, 'No such hold in this brand.');
      }
      if (hold.state !== 'held') return { id, state: hold.state };
      await this.inventory.release(
        tx,
        { orgId: context.orgId, userId: context.userId },
        { refType: 'ncom_hold', refId: hold.id },
      );
      await repo.endHold(tx, { orgId: context.orgId, id: hold.id, state: 'released' });
      return { id, state: 'released' as const };
    });
  }

  /** The orders ncom handed over, with what is waiting to go back. */
  async handedOver(context: ActiveContext) {
    return withOrg(context, async (tx) => {
      const rows = await repo.ncomOrders(tx, context.orgId, 100);
      const outbox = await repo.outboxOf(tx, context.orgId, 200);
      const summaries = new Map(
        (
          await Promise.all(
            rows.map((row) => this.ordersApi.summary(tx, context.orgId, row.order_id)),
          )
        ).flatMap((summary) => (summary === undefined ? [] : [[summary.id, summary] as const])),
      );
      return {
        items: rows.map((row) => {
          const summary = summaries.get(row.order_id);
          return {
            orderId: row.order_id,
            orderNo: summary?.orderNo ?? null,
            status: summary?.status ?? null,
            codAmountPoisha: summary?.codAmountPoisha ?? null,
            ncomOrderId: row.ncom_order_id,
            ncomOrderNumber: row.ncom_order_number,
            storeName: row.store_name,
            pageTitle: row.page_title,
            offerLabel: row.offer_label,
            revision: row.revision,
            stockHeld: row.stock_held,
            foreignItems: row.foreign_items,
            foreignPoisha: String(row.foreign_poisha),
            warnings: row.warnings,
            receivedAt: iso(row.received_at),
            messages: outbox
              .filter((message) => message.order_id === row.order_id)
              .map((message) => ({
                id: message.id,
                topic: message.topic,
                revision: message.revision,
                status: message.status,
                attempts: message.attempts,
                statusCode: message.status_code,
                error: message.error,
                nextAttemptAt: iso(message.next_attempt_at),
                deliveredAt: iso(message.delivered_at),
              })),
          };
        }),
      };
    });
  }
}
