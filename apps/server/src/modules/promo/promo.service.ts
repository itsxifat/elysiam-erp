import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha, toIsoDate, type Poisha } from '@elysium/domain';
import {
  normaliseCode,
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
 * against the row lock and the second is refused. The per-customer limit is checked
 * against the redemption ledger instead and is *not* race-proof for one buyer placing two
 * orders in the same instant: the total limit is what protects the brand's money, and a
 * buyer who gets two of a three-per-customer code is a different order of problem. The
 * unique index per (code, order) is what stops one order redeeming twice.
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
    const lines: PromoBasketLine[] = input.lines.map((line) => ({
      skuId: line.skuId,
      categoryId: skus.get(line.skuId)?.categoryId ?? null,
      netPoisha: poisha(line.netPoisha),
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
        campaignId: input.campaignId ?? null,
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
