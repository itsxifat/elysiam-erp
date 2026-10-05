import { randomBytes } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { SslcommerzSettingsInput } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import {
  gatewayAmount,
  judgeValidation,
  parseGatewayAmount,
  payableOnline,
} from '@elysium/domain/storefront';
import type { Logger } from 'pino';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { serverEnv } from '../../platform/config/env.js';
import {
  open,
  seal,
  SealedBoxUnavailable,
  sealedBoxConfigured,
} from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import * as buying from './buying.repository.js';
import {
  PAYMENT_GATEWAY,
  type GatewayCredentials,
  type PaymentGateway,
} from './sslcommerz.gateway.js';
import { STOREFRONT_CONFIG, type StorefrontConfig } from './storefront.config.js';
import { StorefrontError } from './storefront.errors.js';
import { STOREFRONT_QUEUES } from './storefront.queues.js';
import { StorefrontService } from './storefront.service.js';
import { tokenHash } from './tokens.js';

/** The clearing wallet SSLCommerz payments land in until the gateway settles them (D-526). */
export const SSLCOMMERZ_WALLET = {
  code: '1120',
  name: 'SSLCommerz clearing',
  subtype: 'wallet_mfs_other',
  provider: 'sslcommerz',
} as const;

/** Who records a gateway payment's claim, and who decides it: the checkout and the gateway. */
export const GATEWAY_RECORDER = 'storefront:checkout';
export const GATEWAY_DECIDER = 'gateway:sslcommerz';

const PASSWORD_BINDING = (orgId: string) => ({
  orgId,
  row: 'storefront.gateway_settings',
  field: 'store_password',
});

/** Ours, random and unguessable: 24 characters of A–Z and 0–9 with at least one digit. */
export function newTranId(): string {
  for (;;) {
    const id = [...randomBytes(24)]
      .map((byte) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(byte % 36))
      .join('');
    if (/[0-9]/.test(id)) return id;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Paying online through SSLCommerz (M34, D-525 to D-528).
 *
 * - **Opening a session**: the route records the session and enqueues the worker's call in one
 *   transaction, then waits on the row (at most `STOREFRONT_GATEWAY_WAIT_MS`). The worker calls
 *   SSLCommerz with no transaction open (invariant 6) and writes the gateway page or the
 *   refusal. A retry finds the open session rather than opening a second.
 * - **Being paid**: the website relays SSLCommerz's return (success, fail, cancel) and
 *   SSLCommerz posts its IPN to the ERP. Neither is trusted: a `val_id` is checked with the
 *   Order Validation API by the worker, and a payment is accepted only when SSLCommerz says it is
 *   valid, for this session's transaction, in BDT, for exactly the session's amount, which is
 *   exactly what the order still collects (`judgeValidation`). Anything else is refused and
 *   logged for a person.
 * - **Booking it**: an accepted payment becomes a verified advance (D-526) into the SSLCommerz
 *   clearing wallet, Dr clearing / Cr Customer advance, and the COD falls by the amount — in one
 *   transaction with the session's `paid`, once per session however many times it is told.
 * - **Not being paid**: a failed or cancelled return cancels the order and releases its hold if
 *   it is still pending and unpaid; an order unpaid at sixty minutes is cancelled by a job.
 */
@Injectable()
export class PaymentsService {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('storefront');
    return this.cachedLogger;
  }

  constructor(
    @Inject(STOREFRONT_CONFIG) private readonly config: StorefrontConfig,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(WALLETS_API) private readonly wallets: WalletsApi,
    private readonly settings: StorefrontService,
    private readonly audit: AuditService,
  ) {}

  // --- the console: Website → Payments --------------------------------------------------------

  async settingsView(context: ActiveContext) {
    return withOrg(context, async (tx) => {
      const row = await buying.gatewaySettings(tx, context.orgId);
      return {
        keyConfigured: sealedBoxConfigured(),
        configured: row !== undefined,
        enabled: row?.enabled ?? false,
        mode: row?.mode ?? 'sandbox',
        storeId: row?.store_id ?? '',
        hasPassword: row !== undefined,
        passwordFingerprint: row?.fingerprint ?? null,
        verified: this.gateway.verified,
        ipnUrl: this.ipnUrl(context.orgId),
        wallet: { code: SSLCOMMERZ_WALLET.code, name: SSLCOMMERZ_WALLET.name },
        updatedAt: row === undefined ? null : new Date(row.updated_at).toISOString(),
      };
    });
  }

  async saveSettings(
    context: ActiveContext,
    request: AuditableRequest,
    input: SslcommerzSettingsInput,
  ) {
    let sealed: ReturnType<typeof seal> | undefined;
    try {
      sealed =
        input.storePassword === undefined
          ? undefined
          : seal(input.storePassword, PASSWORD_BINDING(context.orgId));
    } catch (error) {
      if (error instanceof SealedBoxUnavailable) throw credentialsMissing();
      throw error;
    }
    await withOrg(context, async (tx) => {
      const saved = await buying.upsertGatewaySettings(tx, {
        orgId: context.orgId,
        enabled: input.enabled,
        mode: input.mode,
        storeId: input.storeId,
        ...(sealed === undefined
          ? {}
          : {
              password: {
                sealed: sealed.ciphertext,
                keyId: sealed.keyId,
                fingerprint: sealed.fingerprint,
              },
            }),
        updatedBy: context.userId,
      });
      if (!saved) {
        throw new StorefrontError(
          'VALIDATION_FAILED',
          HttpStatus.BAD_REQUEST,
          'storePassword: give the store password the first time SSLCommerz is set up.',
        );
      }
      // The wallet the payments land in exists from the moment the gateway is set up, so
      // accounts sees it (empty) on the wallet screens before the first payment.
      await this.wallets.ensureSystemWallet(tx, context.orgId, SSLCOMMERZ_WALLET);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'storefront.gateway_saved',
        entityType: 'storefront.gateway_settings',
        entityId: context.orgId,
        // Never the password; whether it changed, and which one it is now, by fingerprint.
        after: {
          enabled: input.enabled,
          mode: input.mode,
          storeId: input.storeId,
          passwordChanged: sealed !== undefined,
          passwordFingerprint: sealed?.fingerprint ?? null,
        },
        request,
      });
    });
    return this.settingsView(context);
  }

  async recent(context: ActiveContext, limit: number) {
    return withOrg(context, async (tx) => {
      const rows = await buying.recentSessions(tx, context.orgId, limit);
      const orders = new Map(
        (
          await this.orders.shopperOrders(
            tx,
            context.orgId,
            rows.map((row) => row.order_id),
          )
        ).map((order) => [order.id, order]),
      );
      return {
        items: rows.map((row) => sessionView(row, orders.get(row.order_id)?.orderNo ?? null)),
      };
    });
  }

  /** The order page's online payments (the console). */
  async sessionsOfOrder(tx: Tx, orgId: string, orderId: string, orderNo: string) {
    const rows = await buying.sessionsOfOrder(tx, orgId, orderId);
    return rows.map((row) => sessionView(row, orderNo));
  }

  // --- the website: opening a session -----------------------------------------------------------

  async init(
    site: { readonly orgId: string },
    input: {
      readonly orderNo: string;
      readonly token?: string | undefined;
      readonly accountId?: string | undefined;
    },
  ) {
    const { orgId } = site;
    const opened = await withOrg({ orgId, userId: GATEWAY_RECORDER }, async (tx) => {
      const orderId = await this.orders.orderIdByNumber(tx, orgId, input.orderNo);
      if (orderId === undefined) throw orderNotFound();
      const web = await buying.webOrder(tx, orgId, orderId);
      if (web === undefined) throw orderNotFound();
      const byToken =
        input.token !== undefined &&
        (await buying.orderIdForToken(tx, orgId, tokenHash(input.token))) === orderId;
      const byAccount = input.accountId !== undefined && web.account_id === input.accountId;
      if (!byToken && !byAccount) throw orderNotFound();
      if (web.payment_method !== 'sslcommerz') throw notPayable('This order is cash on delivery.');

      const gateway = await buying.gatewaySettings(tx, orgId);
      if (gateway?.enabled !== true) {
        throw new StorefrontError(
          'PAYMENT_METHOD_UNAVAILABLE',
          HttpStatus.CONFLICT,
          'Paying online is not available on this website.',
        );
      }
      const summary = await this.orders.summary(tx, orgId, orderId);
      if (summary?.status !== 'pending')
        throw notPayable('This order is no longer waiting for a payment.');
      const due = BigInt(summary.codAmountPoisha);
      if (!payableOnline(poisha(due)))
        throw notPayable('Nothing on this order can be paid online.');

      const sessions = await buying.sessionsOfOrder(tx, orgId, orderId);
      if (
        sessions.some((session) => session.status === 'paid' || session.status === 'validating')
      ) {
        throw notPayable('This order is already paid, or its payment is being checked.');
      }
      const now = Date.now();
      const live = sessions.find(
        (session) =>
          (session.status === 'ready' || session.status === 'initiating') &&
          BigInt(session.amount_poisha) === due &&
          new Date(session.expires_at).getTime() > now,
      );
      if (live !== undefined) return live.id;

      const placedAt = new Date(web.created_at).getTime();
      const expiresAt = new Date(
        Math.max(now + 60_000, placedAt + this.config.STOREFRONT_UNPAID_ORDER_MINUTES * 60_000),
      );
      const sessionId = await buying.insertSession(tx, {
        orgId,
        orderId,
        mode: gateway.mode,
        tranId: newTranId(),
        amountPoisha: due,
        expiresAt,
      });
      await enqueue(
        tx,
        STOREFRONT_QUEUES.openSession.name,
        { sessionId },
        { orgId, ref: sessionId },
      );
      return sessionId;
    });

    // Outside every transaction: wait for the worker's answer on the row.
    const deadline = Date.now() + this.config.STOREFRONT_GATEWAY_WAIT_MS;
    for (;;) {
      const session = await withOrg({ orgId }, (tx) => buying.sessionById(tx, orgId, opened));
      if (session?.status === 'ready' && session.gateway_url !== null) {
        return {
          payment: {
            gatewayUrl: session.gateway_url,
            tranId: session.tran_id,
            amount: {
              poisha: session.amount_poisha,
              taka: gatewayAmount(poisha(BigInt(session.amount_poisha))),
            },
            expiresAt: new Date(session.expires_at).toISOString(),
          },
        };
      }
      if (session === undefined || session.status === 'failed' || session.status === 'cancelled') {
        throw new StorefrontError(
          'PAYMENT_GATEWAY_FAILED',
          HttpStatus.BAD_GATEWAY,
          'The payment gateway could not open a payment page. Nothing was charged; try again.',
        );
      }
      if (Date.now() >= deadline) {
        throw new StorefrontError(
          'SERVICE_UNAVAILABLE',
          HttpStatus.SERVICE_UNAVAILABLE,
          'The payment gateway is slow to answer. Try again in a moment; nothing was charged.',
          5,
        );
      }
      await sleep(200);
    }
  }

  /** The `storefront.sslcommerz_open` job: the one call to SSLCommerz that opens a page. */
  async openSession(orgId: string, sessionId: string): Promise<'ready' | 'failed' | 'skipped'> {
    const prepared = await withOrg({ orgId, userId: GATEWAY_RECORDER }, async (tx) => {
      const session = await buying.sessionById(tx, orgId, sessionId);
      if (session?.status !== 'initiating') return null;
      const [order] = await this.orders.shopperOrders(tx, orgId, [session.order_id]);
      const web = await buying.webOrder(tx, orgId, session.order_id);
      const credentials = await this.credentials(tx, orgId);
      const settings = await this.settings.settingsIn(tx, orgId);
      return { session, order, web, credentials, settings };
    });
    if (prepared === null) return 'skipped';
    const { session, order, web, credentials, settings } = prepared;
    const siteUrl = settings.siteInfo.siteUrl.replace(/\/+$/, '');
    let failure: string | null = null;
    if (order === undefined || web === undefined) failure = 'order_missing';
    else if (credentials === null) failure = 'not_configured';
    else if (!siteUrl.startsWith('https://')) failure = 'no_site_url';

    let result: Awaited<ReturnType<PaymentGateway['openSession']>> | null = null;
    if (failure === null && order !== undefined && credentials !== null) {
      result = await this.gateway.openSession(
        credentials,
        {
          tranId: session.tran_id,
          totalAmount: gatewayAmount(poisha(BigInt(session.amount_poisha))),
          successUrl: `${siteUrl}/api/payment/sslcommerz/success`,
          failUrl: `${siteUrl}/api/payment/sslcommerz/fail`,
          cancelUrl: `${siteUrl}/api/payment/sslcommerz/cancel`,
          ipnUrl: this.ipnUrl(orgId),
          customer: {
            name: order.shipTo.name,
            email: web?.email ?? '',
            phone: `0${order.shipTo.phoneE164.slice(4)}`,
            address: order.shipTo.addressLine,
            city: order.shipTo.districtEn ?? 'Dhaka',
          },
          productName: `${settings.siteInfo.siteName} order ${order.orderNo}`,
          itemCount: order.unitCount,
        },
        { timeoutMs: this.config.STOREFRONT_GATEWAY_TIMEOUT_MS },
      );
      if (!result.ok) failure = result.error;
    }

    await withOrg({ orgId, userId: GATEWAY_RECORDER }, (tx) =>
      result?.ok === true
        ? buying.moveSession(tx, {
            orgId,
            id: sessionId,
            from: ['initiating'],
            to: 'ready',
            gatewayUrl: result.gatewayUrl,
            sessionKey: result.sessionKey,
          })
        : buying.moveSession(tx, {
            orgId,
            id: sessionId,
            from: ['initiating'],
            to: 'failed',
            failureReason: failure ?? 'unknown',
          }),
    );
    if (result?.ok === true) return 'ready';
    this.logger.warn({ session: sessionId, reason: failure }, 'an SSLCommerz session did not open');
    return 'failed';
  }

  // --- the website: coming back, and the IPN ----------------------------------------------------

  /**
   * SSLCommerz's return to the website, relayed (D-525). A success names a `val_id`, which the
   * worker checks with the gateway while this waits a little for its answer; a fail or a cancel
   * cancels the order if it is still pending and unpaid (the transaction id is ours and
   * unguessable, so a forged fail cannot name somebody else's order).
   */
  async returned(
    site: { readonly orgId: string },
    input: {
      readonly kind: 'success' | 'fail' | 'cancel';
      readonly tranId: string;
      readonly valId?: string | undefined;
    },
  ) {
    const { orgId } = site;
    const tranId = input.tranId.trim().toUpperCase();
    const session = await withOrg({ orgId }, (tx) => buying.sessionByTranId(tx, orgId, tranId));
    if (session === undefined) throw orderNotFound();
    const orderNo = await withOrg({ orgId }, async (tx) => {
      const [order] = await this.orders.shopperOrders(tx, orgId, [session.order_id]);
      return order?.orderNo ?? null;
    });

    if (input.kind !== 'success' || input.valId === undefined) {
      await this.abandon(orgId, session.id, input.kind === 'cancel' ? 'cancelled' : 'failed');
      const after = await withOrg({ orgId }, (tx) => buying.sessionById(tx, orgId, session.id));
      return { payment: { orderNo, status: after?.status === 'paid' ? 'paid' : 'cancelled' } };
    }

    await withOrg({ orgId, userId: GATEWAY_RECORDER }, (tx) =>
      enqueue(
        tx,
        STOREFRONT_QUEUES.validate.name,
        { sessionId: session.id, valId: input.valId },
        { orgId, ref: session.id },
      ),
    );
    const deadline = Date.now() + this.config.STOREFRONT_GATEWAY_WAIT_MS;
    for (;;) {
      const now = await withOrg({ orgId }, (tx) => buying.sessionById(tx, orgId, session.id));
      if (now?.status === 'paid') return { payment: { orderNo, status: 'paid' } };
      if (now?.status === 'refused') return { payment: { orderNo, status: 'refused' } };
      if (Date.now() >= deadline) return { payment: { orderNo, status: 'checking' } };
      await sleep(250);
    }
  }

  /**
   * SSLCommerz's IPN (D-525): public, unsigned, so nothing in it is believed. Only a session of
   * ours is looked at, and only its `val_id` is used, to ask the Order Validation API.
   */
  async ipn(orgId: string, fields: Readonly<Record<string, string>>): Promise<void> {
    const tranId = (fields.tran_id ?? '').trim().toUpperCase();
    const valId = (fields.val_id ?? '').trim();
    if (!/^[A-Z0-9]{20,30}$/.test(tranId) || valId === '' || valId.length > 80) return;
    await withOrg({ orgId, userId: GATEWAY_RECORDER }, async (tx) => {
      const session = await buying.sessionByTranId(tx, orgId, tranId);
      if (session === undefined || session.status === 'paid' || session.status === 'refused')
        return;
      await enqueue(
        tx,
        STOREFRONT_QUEUES.validate.name,
        { sessionId: session.id, valId },
        { orgId, ref: session.id },
      );
    });
  }

  /** The `storefront.sslcommerz_validate` job: check with the gateway, then book or refuse. */
  async validate(orgId: string, sessionId: string, valId: string): Promise<string> {
    const prepared = await withOrg({ orgId }, async (tx) => {
      const session = await buying.sessionById(tx, orgId, sessionId);
      if (session === undefined || session.status === 'paid' || session.status === 'refused') {
        return null;
      }
      return { session, credentials: await this.credentialsFor(tx, orgId, session.mode) };
    });
    if (prepared === null) return 'settled';
    const { session, credentials } = prepared;
    if (credentials === null) throw new Error('SSLCommerz is not set up for this brand any more');

    const asked = await this.gateway.validate(credentials, valId, {
      timeoutMs: this.config.STOREFRONT_GATEWAY_TIMEOUT_MS,
    });
    if (!asked.ok) throw new Error(`SSLCommerz validation did not answer: ${asked.error}`);
    const verdict = judgeValidation(
      { tranId: session.tran_id, amountPoisha: poisha(BigInt(session.amount_poisha)) },
      asked.answer,
    );
    if (
      !verdict.ok &&
      (verdict.reason === 'not_valid' || verdict.reason === 'transaction_mismatch')
    ) {
      // Not a payment of this session: a forged or stale IPN, or a shopper who did not pay.
      // Nothing changes; the session stays open for a real one.
      this.logger.warn(
        { session: sessionId, reason: verdict.reason },
        'an SSLCommerz payment was not valid',
      );
      return verdict.reason;
    }

    const answer = asked.answer;
    const text = (value: unknown, max: number) =>
      typeof value === 'string' ? value.slice(0, max) : null;
    return withOrg({ orgId, userId: GATEWAY_DECIDER }, async (tx) => {
      const locked = await buying.sessionById(tx, orgId, sessionId, { forUpdate: true });
      if (locked === undefined || locked.status === 'paid' || locked.status === 'refused') {
        return 'settled';
      }
      if (!['ready', 'cancelled', 'expired', 'validating'].includes(locked.status)) {
        // No page was ever opened for it (`initiating`, `failed`): not a payment of ours.
        this.logger.warn(
          { session: sessionId, status: locked.status },
          'a payment named a session with no page',
        );
        return 'no_page';
      }
      const validated = parseGatewayAmount(answer.amount);
      let refusal: string | null = verdict.ok ? null : verdict.reason;
      // The order locked before it is read, the lock every transition takes, so an agent's edit
      // or confirm and this payment happen one after the other.
      await this.orders.bookingSnapshot(tx, orgId, locked.order_id, { forUpdate: true });
      const summary = await this.orders.summary(tx, orgId, locked.order_id);
      if (refusal === null && summary === undefined) refusal = 'order_missing';
      if (
        refusal === null &&
        summary !== undefined &&
        summary.status !== 'cancelled' &&
        BigInt(summary.codAmountPoisha) !== BigInt(locked.amount_poisha)
      ) {
        // The order changed after the page opened (an agent edited it): the money does not
        // match what is owed, so a person decides (D-525).
        refusal = 'amount_mismatch';
      }
      if (refusal !== null || !verdict.ok) {
        await buying.moveSession(tx, {
          orgId,
          id: sessionId,
          from: [locked.status],
          to: 'refused',
          valId,
          validatedAmountPoisha: validated,
          cardType: text(answer.card_type, 80),
          bankTranId: text(answer.bank_tran_id, 80),
          failureReason: refusal ?? 'refused',
          settled: true,
        });
        await this.audit.record(tx, {
          orgId,
          actorUserId: GATEWAY_DECIDER,
          operation: 'reject',
          action: 'storefront.payment_refused',
          entityType: 'order',
          entityId: locked.order_id,
          after: {
            tranId: locked.tran_id,
            reason: refusal ?? 'refused',
            sessionAmountPoisha: locked.amount_poisha,
            validatedAmountPoisha: validated?.toString() ?? null,
          },
        });
        this.logger.error(
          { session: sessionId, reason: refusal },
          'an SSLCommerz payment was refused: it needs a person (refund it from the gateway panel)',
        );
        return refusal ?? 'refused';
      }

      const wallet = await this.wallets.ensureSystemWallet(tx, orgId, SSLCOMMERZ_WALLET);
      const booked = await this.orders.recordGatewayAdvance(
        tx,
        { orgId, recordedBy: GATEWAY_RECORDER, decidedBy: GATEWAY_DECIDER },
        {
          orderId: locked.order_id,
          method: 'sslcommerz',
          transactionRef: locked.tran_id,
          amountPoisha: verdict.amountPoisha,
          wallet,
          note: `SSLCommerz ${text(answer.bank_tran_id, 60) ?? valId.slice(0, 60)}`,
        },
      );
      await buying.moveSession(tx, {
        orgId,
        id: sessionId,
        from: [locked.status],
        to: 'paid',
        valId,
        validatedAmountPoisha: verdict.amountPoisha,
        cardType: text(answer.card_type, 80),
        bankTranId: text(answer.bank_tran_id, 80),
        risky: verdict.risky,
        advanceId: booked.advanceId,
        settled: true,
      });
      await this.audit.record(tx, {
        orgId,
        actorUserId: GATEWAY_DECIDER,
        operation: 'create',
        action: 'storefront.payment_received',
        entityType: 'order',
        entityId: locked.order_id,
        after: {
          tranId: locked.tran_id,
          amountPoisha: verdict.amountPoisha.toString(),
          advanceId: booked.advanceId,
          outcome: booked.outcome,
          risky: verdict.risky,
        },
      });
      return `paid:${booked.outcome}`;
    });
  }

  // --- not being paid ---------------------------------------------------------------------------

  /** A failed or cancelled return: the session ends, and the order if nothing was paid. */
  private async abandon(
    orgId: string,
    sessionId: string,
    how: 'cancelled' | 'failed',
  ): Promise<void> {
    await withOrg({ orgId, userId: GATEWAY_RECORDER }, async (tx) => {
      const session = await buying.sessionById(tx, orgId, sessionId, { forUpdate: true });
      if (session === undefined) return;
      await buying.moveSession(tx, {
        orgId,
        id: sessionId,
        from: ['initiating', 'ready'],
        to: 'cancelled',
        failureReason: how,
      });
      await this.cancelIfUnpaid(
        tx,
        orgId,
        session.order_id,
        'The shopper did not complete the online payment.',
      );
    });
  }

  /** The `storefront.expire_unpaid` job: sixty minutes after an SSLCommerz checkout (D-527). */
  async expireUnpaid(orgId: string, orderId: string): Promise<'cancelled' | 'kept'> {
    return withOrg({ orgId, userId: GATEWAY_RECORDER }, async (tx) => {
      const web = await buying.webOrder(tx, orgId, orderId);
      if (web?.payment_method !== 'sslcommerz') return 'kept';
      const sessions = await buying.sessionsOfOrder(tx, orgId, orderId);
      if (
        sessions.some((session) => session.status === 'validating' || session.status === 'paid')
      ) {
        return 'kept';
      }
      for (const session of sessions) {
        await buying.moveSession(tx, {
          orgId,
          id: session.id,
          from: ['initiating', 'ready'],
          to: 'expired',
          failureReason: 'unpaid',
        });
      }
      return (await this.cancelIfUnpaid(
        tx,
        orgId,
        orderId,
        `Not paid online within ${String(this.config.STOREFRONT_UNPAID_ORDER_MINUTES)} minutes.`,
      ))
        ? 'cancelled'
        : 'kept';
    });
  }

  /**
   * Cancel a website order through the state machine (invariant 7) — which releases its held
   * stock, its discounts and its flash units — only while it is still pending with nothing
   * paid: an agent who already confirmed it, or a payment that arrived, keeps it.
   */
  private async cancelIfUnpaid(
    tx: Tx,
    orgId: string,
    orderId: string,
    reason: string,
  ): Promise<boolean> {
    // Locked first, so an agent confirming it at this moment either wins (and it stays) or
    // waits for the cancel; read unlocked, a confirm in between would be cancelled.
    await this.orders.bookingSnapshot(tx, orgId, orderId, { forUpdate: true });
    const summary = await this.orders.summary(tx, orgId, orderId);
    if (summary?.status !== 'pending' || BigInt(summary.advancePaidPoisha) !== 0n) return false;
    await this.orders.transition(tx, { orgId, userId: GATEWAY_RECORDER }, orderId, 'cancel', {
      reason,
    });
    return true;
  }

  // --- the pieces --------------------------------------------------------------------------------

  private ipnUrl(orgId: string): string {
    const base =
      this.config.STOREFRONT_IPN_BASE_URL ?? serverEnv().API_PUBLIC_URL.replace(/\/+$/, '');
    return `${base}/storefront/ipn/sslcommerz/${orgId}`;
  }

  private async credentials(tx: Tx, orgId: string): Promise<GatewayCredentials | null> {
    const row = await buying.gatewaySettings(tx, orgId);
    if (row?.enabled !== true) return null;
    return this.open(orgId, row);
  }

  /** The credentials for a session's mode, even if the gateway was switched off since. */
  private async credentialsFor(
    tx: Tx,
    orgId: string,
    mode: 'sandbox' | 'live',
  ): Promise<GatewayCredentials | null> {
    const row = await buying.gatewaySettings(tx, orgId);
    if (row?.mode !== mode) return null;
    return this.open(orgId, row);
  }

  private open(orgId: string, row: buying.GatewaySettingsRow): GatewayCredentials | null {
    try {
      return {
        storeId: row.store_id,
        storePassword: open(row.password_sealed, PASSWORD_BINDING(orgId)),
        mode: row.mode,
      };
    } catch (error) {
      if (error instanceof SealedBoxUnavailable) return null;
      throw error;
    }
  }
}

function sessionView(row: buying.SessionRow, orderNo: string | null) {
  return {
    id: row.id,
    orderId: row.order_id,
    orderNo,
    tranId: row.tran_id,
    mode: row.mode,
    status: row.status,
    amountPoisha: row.amount_poisha,
    validatedAmountPoisha: row.validated_amount_poisha,
    cardType: row.card_type,
    risky: row.risky,
    failureReason: row.failure_reason,
    advanceId: row.advance_id,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
  };
}

function orderNotFound(): StorefrontError {
  return new StorefrontError('NOT_FOUND', HttpStatus.NOT_FOUND, 'No such order.');
}

function notPayable(message: string): StorefrontError {
  return new StorefrontError('PAYMENT_NOT_PAYABLE', HttpStatus.CONFLICT, message);
}

function credentialsMissing(): StorefrontError {
  return new StorefrontError(
    'WEBSITE_CREDENTIALS_MISSING',
    HttpStatus.SERVICE_UNAVAILABLE,
    'Set STOREFRONT_CREDENTIALS_KEY on the server before saving gateway credentials.',
  );
}
