import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha, toIsoDate, type Poisha } from '@elysium/domain';
import {
  normaliseCode,
  promoBasis,
  validatePromo,
  type PromoBasketLine,
  type PromoCode,
  type PromoVerdict,
} from '@elysium/domain/promo';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { PromoError } from './promo.errors.js';
import * as repo from './promo.repository.js';
import type { CreatePromoCodeInput } from './promo.schemas.js';

/**
 * Promo codes: what a code is worth here, and the record that it was spent (M16, §10).
 *
 * Two rules shape this file.
 *
 * **The discount is never the client's.** A caller sends a *code* and a basket of line
 * ids and quantities; the server prices the lines, asks the domain what the code is
 * worth, and writes that. An endpoint that accepted an amount would be an endpoint where
 * the discount is whatever the browser says, and the order's books are built from it.
 *
 * **A limit is kept by the database, not by a read.** `claimUse` is a conditional UPDATE
 * (`used_count < total_limit`), so two orders claiming the last use of a code resolve
 * against the row lock and the second is refused. The per-customer limit is read once
 * when the code is priced and counted again in `redeem`, under that same row lock — so
 * one buyer's two orders in the same instant cannot both take a buyer's last use (ledger
 * audit W1). The unique index per (code, order) is what stops one order redeeming twice.
 */
@Injectable()
export class PromoService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly audit: AuditService,
  ) {}

  /** What this code is worth for this basket, or why it is not. Reads nothing but. */
  async check(
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      /** The agent's typed order discount, spread over the lines first (`promoBasis`, W3). */
      readonly orderDiscountPoisha?: string;
      readonly deliveryChargePoisha: string;
      readonly channel: string;
      readonly customerId: string | null;
    },
  ): Promise<
    | {
        readonly ok: true;
        readonly codeId: string;
        readonly discountPoisha: string;
        readonly deliveryDiscountPoisha: string;
      }
    | { readonly ok: false; readonly reason: string }
  > {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const verdict = await this.verdictFor(tx, context.orgId, input);
      if (!verdict.verdict.ok) return { ok: false as const, reason: verdict.verdict.reason };
      return {
        ok: true as const,
        codeId: verdict.code.id,
        discountPoisha: verdict.verdict.discountPoisha.toString(),
        deliveryDiscountPoisha: verdict.verdict.deliveryDiscountPoisha.toString(),
      };
    });
  }

  /**
   * Price a code against a basket, inside the caller's transaction.
   *
   * Separate from `check` so the order desk and the till can call it in the same
   * transaction that writes the order: validating in one transaction and redeeming in
   * another is how a code that was valid a moment ago gets applied after it ran out.
   */
  async verdictFor(
    tx: Tx,
    orgId: string,
    input: {
      readonly code: string;
      readonly lines: readonly { readonly skuId: string; readonly netPoisha: string }[];
      /** The agent's typed order discount, spread over the lines first (`promoBasis`, W3). */
      readonly orderDiscountPoisha?: string;
      readonly deliveryChargePoisha: string;
      readonly channel: string;
      readonly customerId: string | null;
      readonly on?: string;
    },
  ): Promise<{ readonly code: repo.PromoCodeRow; readonly verdict: PromoVerdict }> {
    const row = await repo.codeByWord(tx, orgId, input.code);
    if (row === undefined) {
      throw new PromoError('PROMO_NOT_FOUND', 'No such code for this brand.');
    }

    // Each line's category, from the module that owns the catalog (invariant 12).
    const skuIds = [...new Set(input.lines.map((line) => line.skuId))];
    const skus = new Map(
      (await this.catalog.skusByIds(tx, orgId, skuIds)).map((sku) => [sku.id, sku]),
    );
    const basis = promoBasis(
      input.lines.map((line) => ({ skuId: line.skuId, netPoisha: poisha(line.netPoisha) })),
      poisha(input.orderDiscountPoisha ?? '0'),
    );
    const lines: PromoBasketLine[] = basis.map((line) => ({
      skuId: line.skuId,
      categoryId: skus.get(line.skuId)?.categoryId ?? null,
      netPoisha: line.netPoisha,
    }));

    const usage = await repo.usageOf(tx, orgId, row.id, input.customerId);
    const verdict = validatePromo(
      toPromoCode(row),
      {
        lines,
        deliveryChargePoisha: poisha(input.deliveryChargePoisha),
        channel: input.channel,
        customerId: input.customerId,
        on: input.on === undefined ? businessDate(new Date()) : toIsoDate(input.on),
      },
      usage,
    );

    return { code: row, verdict };
  }

  /**
   * Take a use of the code and record the discount, in the caller's transaction.
   *
   * Returns what was actually given, which the caller writes onto its own row — the order
   * or the till sale — so the discount in the books and the discount in the redemption
   * ledger are the same number by construction.
   *
   * A second call for the same order returns the first redemption's amounts and claims no
   * further use: the unique index per (code, order) decides that, not a prior read.
   */
  async redeem(
    tx: Tx,
    context: ActiveContext,
    input: {
      readonly codeId: string;
      readonly orderId: string | null;
      readonly posSaleId: string | null;
      readonly customerId: string | null;
      readonly discountPoisha: Poisha;
      readonly deliveryDiscountPoisha: Poisha;
    },
  ): Promise<{ readonly redemptionId: string; readonly replayed: boolean }> {
    const claimed = await repo.claimUse(tx, context.orgId, input.codeId);
    if (claimed === undefined) {
      throw new PromoError(
        'PROMO_NOT_APPLICABLE',
        'That code has been used as many times as it allows.',
        'limit_reached',
      );
    }

    /*
     * The per-buyer limit, checked again now that the claim holds the code's row lock.
     *
     * `validatePromo` saw a count read before the lock, and two orders for one buyer can
     * both read 0 against a limit of 1 (ledger audit W1). This count cannot be stale: any
     * order that redeemed first has committed, or this transaction would still be waiting
     * on the UPDATE. Refusing throws, which rolls the claim back with everything else.
     */
    if (input.customerId !== null && claimed.perCustomerLimit !== null) {
      const already = await repo.appliedByCustomer(
        tx,
        context.orgId,
        input.codeId,
        input.customerId,
        input.orderId,
      );
      if (already >= claimed.perCustomerLimit) {
        throw new PromoError(
          'PROMO_NOT_APPLICABLE',
          'This buyer has already used that code as many times as it allows.',
          'customer_limit_reached',
        );
      }
    }

    const redemptionId = await repo.insertRedemption(tx, {
      orgId: context.orgId,
      codeId: input.codeId,
      orderId: input.orderId,
      posSaleId: input.posSaleId,
      customerId: input.customerId,
      discountPoisha: input.discountPoisha,
      deliveryDiscountPoisha: input.deliveryDiscountPoisha,
    });

    if (redemptionId === undefined) {
      // This target already had a redemption of this code: give the use back, because the
      // one that counts was claimed by the first attempt.
      await repo.releaseUse(tx, context.orgId, input.codeId);
      const existing =
        input.orderId === null
          ? undefined
          : await repo.appliedForOrder(tx, context.orgId, input.orderId);
      if (existing === undefined) {
        throw new PromoError(
          'PROMO_REDEMPTION_IMMUTABLE',
          'That code is already recorded against this sale.',
        );
      }
      return { redemptionId: existing.id, replayed: true };
    }

    return { redemptionId, replayed: false };
  }

  /**
   * Give a code's use back when an order is cancelled before it ships.
   *
   * Nothing to do when the order carried no code, or when it was already released — a
   * cancel delivered twice must not return two uses, which the conditional update in
   * `releaseRedemption` is what decides.
   */
  async releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    const applied = await repo.appliedForOrder(tx, orgId, orderId);
    if (applied === undefined) return false;
    const released = await repo.releaseRedemption(tx, orgId, applied.id);
    if (released) await repo.releaseUse(tx, orgId, applied.code_id);
    return released;
  }

  /**
   * A personal, single-use code for one buyer's occasion, inside the caller's transaction.
   *
   * The caller's transaction because the code, the message announcing it and the row
   * recording that the greeting was sent commit together or not at all (M16 check 2): a
   * buyer is never told about a code that was rolled back, and never holds one nobody
   * told them about.
   *
   * The word is generated here. A collision with an existing code is retried with a fresh
   * word rather than failed, because the buyer did nothing wrong; three tries against a
   * 32-bit random suffix is far past any brand's code count.
   */
  async issueOccasionCode(
    tx: Tx,
    orgId: string,
    input: {
      readonly customerId: string;
      readonly occasion: 'birthday' | 'anniversary';
      readonly kind: 'percent' | 'flat';
      readonly valueBps: number;
      readonly valuePoisha: bigint;
      readonly validFrom: string;
      readonly validTo: string;
      readonly actorUserId: string;
    },
  ): Promise<{ readonly codeId: string; readonly code: string }> {
    const prefix = input.occasion === 'birthday' ? 'BDAY' : 'ANNIV';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = `${prefix}${randomBytes(4).toString('hex').toUpperCase()}`;
      const codeId = await repo.insertCode(tx, {
        orgId,
        code,
        kind: input.kind,
        valueBps: input.kind === 'percent' ? input.valueBps : 0,
        valuePoisha: input.kind === 'flat' ? input.valuePoisha : 0n,
        minOrderPoisha: null,
        maxDiscountPoisha: null,
        totalLimit: 1,
        perCustomerLimit: 1,
        validFrom: input.validFrom,
        validTo: input.validTo,
        channels: [],
        skuIds: [],
        categoryIds: [],
        customerId: input.customerId,
        campaignId: null,
        origin: 'occasion',
        createdBy: input.actorUserId,
      });
      if (codeId === undefined) continue;

      await this.audit.record(tx, {
        orgId,
        actorUserId: input.actorUserId,
        operation: 'create',
        action: 'promo.code.issued_for_occasion',
        entityType: 'PromoCode',
        entityId: codeId,
        before: null,
        after: { code, occasion: input.occasion, customerId: input.customerId },
      });
      return { codeId, code };
    }
    throw new Error('three random occasion codes collided; the code space is exhausted');
  }

  async list(context: ActiveContext, filters: { status?: string | undefined; limit: number }) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listCodes(tx, context.orgId, filters);
      return { items: rows.map(toView) };
    });
  }

  async create(context: ActiveContext, request: AuditableRequest, input: CreatePromoCodeInput) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const code = normaliseCode(input.code);
      const id = await repo.insertCode(tx, {
        orgId: context.orgId,
        code,
        kind: input.kind,
        valueBps: input.valueBps ?? 0,
        valuePoisha: BigInt(input.valuePoisha ?? '0'),
        minOrderPoisha: input.minOrderPoisha === undefined ? null : BigInt(input.minOrderPoisha),
        maxDiscountPoisha:
          input.maxDiscountPoisha === undefined ? null : BigInt(input.maxDiscountPoisha),
        totalLimit: input.totalLimit ?? null,
        perCustomerLimit: input.perCustomerLimit ?? null,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        channels: input.channels ?? [],
        skuIds: input.skuIds ?? [],
        categoryIds: input.categoryIds ?? [],
        customerId: input.customerId ?? null,
        // Not accepted until M18 builds campaigns and the composite FK that checks the id
        // belongs to this brand; a bare uuid now would be a row that migration rejects.
        campaignId: null,
        origin: 'manual',
        createdBy: context.userId,
      });
      if (id === undefined) {
        throw new PromoError('PROMO_CODE_TAKEN', `This brand already has the code ${code}.`);
      }

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'promo.code.created',
        entityType: 'PromoCode',
        entityId: id,
        before: null,
        after: { code, kind: input.kind },
        requestId: context.requestId,
        request,
      });

      const saved = await repo.codeById(tx, context.orgId, id);
      if (saved === undefined) throw new Error('a code inserted in this transaction is gone');
      return toView(saved);
    });
  }

  async setStatus(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    status: 'active' | 'paused' | 'archived',
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.codeById(tx, context.orgId, id);
      if (before === undefined) throw new PromoError('PROMO_NOT_FOUND', 'No such code.');

      await repo.setCodeStatus(tx, context.orgId, id, status);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'promo.code.status',
        entityType: 'PromoCode',
        entityId: id,
        before: { status: before.status },
        after: { status },
        requestId: context.requestId,
        request,
      });
      return { id, status };
    });
  }

  async redemptionsOf(context: ActiveContext, codeId: string, limit: number) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listRedemptions(tx, context.orgId, codeId, limit);
      return {
        items: rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          posSaleId: row.pos_sale_id,
          customerId: row.customer_id,
          discountPoisha: row.discount_poisha,
          deliveryDiscountPoisha: row.delivery_discount_poisha,
          status: row.status,
        })),
      };
    });
  }
}

/** A stored row as the domain's rule reads it. Arrays arrive from `jsonb`. */
function toPromoCode(row: repo.PromoCodeRow): PromoCode {
  const words = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return {
    id: row.id,
    code: row.code,
    kind: row.kind as PromoCode['kind'],
    valueBps: row.value_bps,
    valuePoisha: poisha(row.value_poisha),
    minOrderPoisha: row.min_order_poisha === null ? null : poisha(row.min_order_poisha),
    maxDiscountPoisha: row.max_discount_poisha === null ? null : poisha(row.max_discount_poisha),
    totalLimit: row.total_limit,
    perCustomerLimit: row.per_customer_limit,
    validFrom: row.valid_from === null ? null : toIsoDate(row.valid_from),
    validTo: row.valid_to === null ? null : toIsoDate(row.valid_to),
    channels: words(row.channels),
    skuIds: words(row.sku_ids),
    categoryIds: words(row.category_ids),
    customerId: row.customer_id,
    status: row.status as PromoCode['status'],
  };
}

function toView(row: repo.PromoCodeRow) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    valueBps: row.value_bps,
    valuePoisha: row.value_poisha,
    minOrderPoisha: row.min_order_poisha,
    maxDiscountPoisha: row.max_discount_poisha,
    totalLimit: row.total_limit,
    perCustomerLimit: row.per_customer_limit,
    usedCount: row.used_count,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    channels: row.channels,
    skuIds: row.sku_ids,
    categoryIds: row.category_ids,
    customerId: row.customer_id,
    campaignId: row.campaign_id,
    origin: row.origin,
    status: row.status,
  };
}
