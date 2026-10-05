import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { EmailSettingsInput } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { maskEmail } from '@elysium/domain/notify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { SealedBoxUnavailable } from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { NOTIFY_API, type NotifyApi } from '../notify/notify.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import * as buying from './buying.repository.js';
import { PaymentsService } from './payments.service.js';
import { StorefrontError } from './storefront.errors.js';
import { StorefrontService } from './storefront.service.js';

/**
 * The console's side of buying on the website (M34): Website → Email and Customers, and what
 * the order page and the buyer profile show about the website (D-533). Payments are
 * `PaymentsService`'s.
 */
@Injectable()
export class CommerceService {
  constructor(
    @Inject(NOTIFY_API) private readonly notify: NotifyApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly settings: StorefrontService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
  ) {}

  // --- Website → Email ----------------------------------------------------------------------------

  async emailSettings(context: ActiveContext) {
    return withOrg(context, (tx) => this.notify.emailSettings(tx, context.orgId));
  }

  async saveEmailSettings(
    context: ActiveContext,
    request: AuditableRequest,
    input: EmailSettingsInput,
  ) {
    try {
      await withOrg(context, async (tx) => {
        await this.notify.saveEmailSettings(tx, context.orgId, input, context.userId);
        const saved = await this.notify.emailSettings(tx, context.orgId);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'storefront.email_settings_saved',
          entityType: 'notify.email_settings',
          entityId: context.orgId,
          // Never the password: whether it changed and which one it is now, by fingerprint.
          after: {
            enabled: input.enabled,
            host: input.host,
            port: input.port,
            secure: input.secure,
            fromEmailMasked: maskEmail(input.fromEmail),
            passwordChanged: input.password !== undefined,
            passwordFingerprint: saved.passwordFingerprint,
          },
          request,
        });
      });
    } catch (error) {
      if (error instanceof SealedBoxUnavailable) {
        throw new StorefrontError(
          'WEBSITE_CREDENTIALS_MISSING',
          HttpStatus.SERVICE_UNAVAILABLE,
          'Set STOREFRONT_CREDENTIALS_KEY on the server before saving the email server’s password.',
        );
      }
      throw error;
    }
    return this.emailSettings(context);
  }

  /** A test through the saved server, now (no transaction open while the server answers). */
  async sendTestEmail(context: ActiveContext, to: string) {
    const brand = await withOrg(context, async (tx) => {
      return (await this.settings.settingsIn(tx, context.orgId)).siteInfo.siteName;
    });
    const result = await this.notify.sendTestEmail(context.orgId, to, brand);
    return result.ok ? { sent: true, error: null } : { sent: false, error: result.error };
  }

  async emailLog(context: ActiveContext, limit: number) {
    return withOrg(context, async (tx) => ({
      items: await this.notify.recentEmails(tx, context.orgId, limit),
    }));
  }

  // --- Website → Customers ------------------------------------------------------------------------

  async accounts(
    context: ActiveContext,
    query: {
      readonly q?: string | undefined;
      readonly customerId?: string | undefined;
      readonly limit: number;
      readonly offset: number;
    },
  ) {
    return withOrg(context, async (tx) => {
      const { rows, total } = await buying.listAccounts(tx, context.orgId, query);
      return {
        items: rows.map((row) => ({
          id: row.id,
          email: row.email,
          emailVerified: row.email_verified_at !== null,
          name: row.name,
          phone: row.phone_e164,
          customerId: row.customer_id,
          googleLinked: row.google_sub !== null,
          source: row.source,
          orderCount: row.order_count,
          lastSignInAt: buying.iso(row.last_sign_in_at),
          createdAt: new Date(row.created_at).toISOString(),
        })),
        total,
      };
    });
  }

  // --- the order page -----------------------------------------------------------------------------

  /** A website order's account, how it was paid and its online payments; null for a desk order. */
  async orderWebsite(context: ActiveContext, orderId: string, request: object) {
    return withOrg(context, async (tx) => {
      // The caller's own reach over orders: an order they cannot open has no card either.
      if (!(await this.orders.orderVisibleTo(tx, context.orgId, orderId, request))) {
        throw new StorefrontError('NOT_FOUND', HttpStatus.NOT_FOUND, 'No such order.');
      }
      const web = await buying.webOrder(tx, context.orgId, orderId);
      if (web === undefined) return { website: null };
      const [order] = await this.orders.shopperOrders(tx, context.orgId, [orderId]);
      const account =
        web.account_id === null
          ? undefined
          : await buying.accountById(tx, context.orgId, web.account_id);
      return {
        website: {
          paymentMethod: web.payment_method,
          email: web.email,
          locale: web.locale,
          account:
            account === undefined
              ? null
              : {
                  id: account.id,
                  email: account.email,
                  name: account.name,
                  emailVerified: account.email_verified_at !== null,
                },
          payments: await this.payments.sessionsOfOrder(
            tx,
            context.orgId,
            orderId,
            order?.orderNo ?? '',
          ),
        },
      };
    });
  }
}
