import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha, toIsoDate, type Poisha } from '@elysium/domain';
import {
  computeDiscounts,
  evaluateDiscount,
  normaliseCode,
  promoBasis,
  type Discount,
  type DiscountBasket,
  type DiscountKind,
  type DiscountLine,
  type DiscountReason,
  type DiscountVerdict,
} from '@elysium/domain/promo';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { BuyerHistoryRegistry } from './ports/buyer-history.port.js';
import { PromoError } from './promo.errors.js';
import * as repo from './promo.repository.js';
import type { CreatePromoCodeInput } from './promo.schemas.js';

/**
 * Discounts: what a basket is worth here, and the record that it was spent (M16, M35a; §10).
 *
 * Two rules shape this file.
 *
 * **The discount is never the client's.** A caller sends codes and a basket of line ids,
 * quantities and the prices the server itself set; the domain decides what each discount
 * is worth (`computeDiscounts`, the one engine the desk and the website share, D-540), and
 * that is what is written. An endpoint that accepted an amount would be an endpoint where
 * the discount is whatever the browser says, and the order's books are built from it.
 *
 * **A limit is kept by the database, not by a read.** `claimUse` is a conditional UPDATE
 * (`used_count < total_limit`), so two orders claiming the last use of a code resolve
 * against the row lock and the second is refused. The per-customer limit is read once
 * when the code is priced and counted again in `redeem`, under that same row lock — so
 * one buyer's two orders in the same instant cannot both take a buyer's last use (ledger
 * audit W1). The unique index per (code, order) is what stops one order redeeming twice.
 */

/** A line as the caller prices it: its own net, after any typed line discount. */
export interface PricedLine {
  readonly skuId: string;
  /** Whole units; one when the caller does not say (M16's live check sent none). */
  readonly qty?: number | undefined;
  readonly netPoisha: string;
}

export interface QuoteInput {
  readonly lines: readonly PricedLine[];
  /** The agent's typed order discount, spread over the lines first (`promoBasis`, W3). */
  readonly orderDiscountPoisha?: string | undefined;
  readonly deliveryChargePoisha: string;
  readonly channel: string;
  readonly customerId: string | null;
  readonly codes: readonly string[];
  /** Consider the brand's automatic discounts too. The desk does not (D-544). */
  readonly automatic: boolean;
  readonly now: Date;
  /** The order's Asia/Dhaka business date; the date of `now` when absent. */
  readonly on?: string | undefined;
}

/** What a basket gets: each discount applied, its amounts, and why each typed code did not. */
export interface DiscountQuote {
  readonly applied: readonly AppliedDiscountView[];
  readonly refused: readonly { readonly code: string; readonly reason: QuoteRefusal }[];
  readonly discountPoisha: Poisha;
  readonly deliveryDiscountPoisha: Poisha;
}

export interface AppliedDiscountView {
  readonly discountId: string;
  readonly method: 'code' | 'automatic';
  readonly code: string | null;
  readonly title: string;
  readonly kind: DiscountKind;
  readonly discountPoisha: Poisha;
  readonly deliveryDiscountPoisha: Poisha;
}

/** A refusal from the engine, or a word that names no discount of this brand. */
export type QuoteRefusal = DiscountReason | 'not_found';

@Injectable()
export class PromoService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly audit: AuditService,
    private readonly buyers: BuyerHistoryRegistry,
  ) {}

  /** What this code is worth for this basket, or why it is not. Reads nothing but. */
  async check(
    context: ActiveContext,
    input: {
      readonly code: string;
      readonly lines: readonly PricedLine[];
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
   * Price one code against a basket, inside the caller's transaction (the desk's path).
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
      readonly lines: readonly PricedLine[];
      readonly orderDiscountPoisha?: string;
      readonly deliveryChargePoisha: string;
      readonly channel: string;
      readonly customerId: string | null;
      readonly on?: string;
    },
  ): Promise<{ readonly code: repo.PromoCodeRow; readonly verdict: DiscountVerdict }> {
    const row = await repo.codeByWord(tx, orgId, input.code);
    if (row?.code == null) {
      throw new PromoError('PROMO_NOT_FOUND', 'No such code for this brand.');
    }
    const discounts = await this.discountsOf(tx, orgId, [row]);
    const basket = await this.basketFor(tx, orgId, {
      lines: input.lines,
      orderDiscountPoisha: input.orderDiscountPoisha,
      deliveryChargePoisha: input.deliveryChargePoisha,
      channel: input.channel,
      customerId: input.customerId,
      now: new Date(),
      on: input.on,
      needsHistory: discounts.some((discount) => discount.firstOrderOnly),
    });
    const usage = await repo.usageOf(tx, orgId, row.id, input.customerId);
    const discount = discounts[0];
    if (discount === undefined) throw new Error('a discount read in this transaction is gone');
    return { code: row, verdict: evaluateDiscount(discount, basket, usage) };
  }

  /**
   * Every discount a basket gets, inside the caller's transaction (M35a; the website's path).
   *
   * The candidates are the brand's active automatic discounts (when `automatic`) and the
   * discounts the typed words name; a word that names none comes back refused as
   * `not_found`. Claims nothing: `redeemQuote` takes the uses, in the order's transaction.
   */
  async quote(tx: Tx, orgId: string, input: QuoteInput): Promise<DiscountQuote> {
    const words = [...new Set(input.codes.map(normaliseCode).filter((word) => word !== ''))];
    const [automatic, named] = await Promise.all([
      input.automatic ? repo.activeAutomatic(tx, orgId) : Promise.resolve([]),
      repo.codesByWords(tx, orgId, words),
    ]);
    const known = new Set(named.map((row) => row.code));
    const rows = [...automatic, ...named];
    const discounts = await this.discountsOf(tx, orgId, rows);
    const basket = await this.basketFor(tx, orgId, {
      lines: input.lines,
      orderDiscountPoisha: input.orderDiscountPoisha,
      deliveryChargePoisha: input.deliveryChargePoisha,
      channel: input.channel,
      customerId: input.customerId,
      now: input.now,
      on: input.on,
      needsHistory: discounts.some((discount) => discount.firstOrderOnly),
    });
    const usage = await repo.usageOfMany(
      tx,
      orgId,
      rows.map((row) => row.id),
      input.customerId,
    );
    const result = computeDiscounts({ discounts, basket, codes: words, usage });
    const titles = new Map(rows.map((row) => [row.id, row.title]));

    return {
      applied: result.applied.map((entry) => ({
        discountId: entry.discount.id,
        method: entry.discount.method,
        code: entry.discount.code,
        title: titles.get(entry.discount.id) ?? '',
        kind: entry.discount.kind,
        discountPoisha: entry.discountPoisha,
        deliveryDiscountPoisha: entry.deliveryDiscountPoisha,
      })),
      refused: [
        ...words
          .filter((word) => !known.has(word))
          .map((code) => ({ code, reason: 'not_found' as const })),
        ...result.refused,
      ],
      discountPoisha: result.discountPoisha,
      deliveryDiscountPoisha: result.deliveryDiscountPoisha,
    };
  }

  /**
   * Take a use of every discount a quote applied and record each against the order, in the
   * order's transaction (M35a).
   *
   * In id order, so two orders claiming the same discounts take their row locks in the same
   * order and cannot deadlock. Any refusal throws, and the caller's transaction rolls back
   * the order with every use already taken.
   */
  async redeemQuote(
    tx: Tx,
    context: { readonly orgId: string },
    input: {
      readonly orderId: string;
      readonly customerId: string | null;
      readonly applied: readonly AppliedDiscountView[];
    },
  ): Promise<{ readonly redemptionIds: readonly string[] }> {
    const ordered = [...input.applied].sort((a, b) =>
      a.discountId < b.discountId ? -1 : a.discountId > b.discountId ? 1 : 0,
    );
    const redemptionIds: string[] = [];
    for (const entry of ordered) {
      const { redemptionId } = await this.redeem(tx, context, {
        codeId: entry.discountId,
        orderId: input.orderId,
        posSaleId: null,
        customerId: input.customerId,
        discountPoisha: entry.discountPoisha,
        deliveryDiscountPoisha: entry.deliveryDiscountPoisha,
      });
      redemptionIds.push(redemptionId);
    }
    return { redemptionIds };
  }

  /** Rows as the engine reads them, with their tiers, in one query for the tiers. */
  private async discountsOf(
    tx: Tx,
    orgId: string,
    rows: readonly repo.PromoCodeRow[],
  ): Promise<Discount[]> {
    const tiered = rows.filter((row) => row.kind === 'tiered').map((row) => row.id);
    const tiers = await repo.tiersOf(tx, orgId, tiered);
    return rows.map((row) => toDiscount(row, tiers.get(row.id) ?? []));
  }

  /**
   * The basket the engine prices: each line's product and category ancestry from the
   * catalog (invariant 12), the agent's typed order discount spread across the lines first
   * (W3), and whether this is the buyer's first order when a discount asks.
   */
  private async basketFor(
    tx: Tx,
    orgId: string,
    input: {
      readonly lines: readonly PricedLine[];
      readonly orderDiscountPoisha: string | undefined;
      readonly deliveryChargePoisha: string;
      readonly channel: string;
      readonly customerId: string | null;
      readonly now: Date;
      readonly on: string | undefined;
      readonly needsHistory: boolean;
    },
  ): Promise<DiscountBasket> {
    const skuIds = [...new Set(input.lines.map((line) => line.skuId))];
    const skus = new Map(
      (await this.catalog.skusByIds(tx, orgId, skuIds)).map((sku) => [sku.id, sku]),
    );
    const categoryIds = [
      ...new Set(
        [...skus.values()].map((sku) => sku.categoryId).filter((id): id is string => id !== null),
      ),
    ];
    const lineage = await this.catalog.categoryLineage(tx, orgId, categoryIds);
    const basis = promoBasis(
      input.lines.map((line) => ({ skuId: line.skuId, netPoisha: poisha(line.netPoisha) })),
      poisha(input.orderDiscountPoisha ?? '0'),
    );
    const lines: DiscountLine[] = basis.map((line, index) => {
      const sku = skus.get(line.skuId);
      const categoryId = sku?.categoryId ?? null;
      return {
        skuId: line.skuId,
        productId: sku?.productId ?? null,
        categoryIds: categoryId === null ? [] : (lineage.get(categoryId) ?? [categoryId]),
        qty: input.lines[index]?.qty ?? 1,
        netPoisha: line.netPoisha,
      };
    });

    return {
      lines,
      deliveryChargePoisha: poisha(input.deliveryChargePoisha),
      channel: input.channel,
      customerId: input.customerId,
      // Asked only when a discount needs it: the answer costs the orders module a query.
      isFirstOrder: input.needsHistory
        ? await this.buyers.isFirstOrder(tx, orgId, input.customerId)
        : false,
      on: input.on === undefined ? businessDate(input.now) : toIsoDate(input.on),
      now: input.now,
    };
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
    context: { readonly orgId: string },
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
     * The quote saw a count read before the lock, and two orders for one buyer can
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
          : await repo.appliedForCodeAndOrder(tx, context.orgId, input.codeId, input.orderId);
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
   * Give every discount's use back when an order is cancelled before it ships.
   *
   * Nothing to do when the order carried none, or when they were already released — a
   * cancel delivered twice must not return two uses, which the conditional update in
   * `releaseRedemption` is what decides. True when anything was released.
   */
  async releaseForOrder(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    let released = false;
    for (const applied of await repo.appliedForOrder(tx, orgId, orderId)) {
      if (await repo.releaseRedemption(tx, orgId, applied.id)) {
        await repo.releaseUse(tx, orgId, applied.code_id);
        released = true;
      }
    }
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
        ...M16_DEFAULTS,
        orgId,
        code,
        title: code,
        kind: input.kind,
        valueBps: input.kind === 'percent' ? input.valueBps : 0,
        valuePoisha: input.kind === 'flat' ? input.valuePoisha : 0n,
        totalLimit: 1,
        perCustomerLimit: 1,
        validFrom: input.validFrom,
        validTo: input.validTo,
        customerId: input.customerId,
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

  async list(
    context: ActiveContext,
    filters: {
      status?: string | undefined;
      method?: string | undefined;
      limit: number;
    },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listCodes(tx, context.orgId, filters);
      const tiers = await repo.tiersOf(
        tx,
        context.orgId,
        rows.filter((row) => row.kind === 'tiered').map((row) => row.id),
      );
      return { items: rows.map((row) => toView(row, tiers.get(row.id) ?? [])) };
    });
  }

  async create(context: ActiveContext, request: AuditableRequest, input: CreatePromoCodeInput) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const method = input.method ?? 'code';
      const code = method === 'code' && input.code !== undefined ? normaliseCode(input.code) : null;
      const title = (input.title ?? code ?? '').trim();
      const id = await repo.insertCode(tx, {
        orgId: context.orgId,
        method,
        code,
        title,
        description: (input.description ?? '').trim(),
        kind: input.kind,
        valueBps: input.valueBps ?? 0,
        valuePoisha: BigInt(input.valuePoisha ?? '0'),
        buyQuantity: input.kind === 'buy_x_get_y' ? (input.buyQuantity ?? null) : null,
        getQuantity: input.kind === 'buy_x_get_y' ? (input.getQuantity ?? null) : null,
        getDiscountBps: input.kind === 'buy_x_get_y' ? (input.getDiscountBps ?? 10_000) : null,
        minOrderPoisha: input.minOrderPoisha === undefined ? null : BigInt(input.minOrderPoisha),
        minQuantity: input.minQuantity ?? null,
        firstOrderOnly: input.firstOrderOnly ?? false,
        maxDiscountPoisha:
          input.maxDiscountPoisha === undefined ? null : BigInt(input.maxDiscountPoisha),
        totalLimit: input.totalLimit ?? null,
        perCustomerLimit: input.perCustomerLimit ?? null,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        startsAt: input.startsAt === undefined ? null : new Date(input.startsAt),
        endsAt: input.endsAt === undefined ? null : new Date(input.endsAt),
        channels: input.channels ?? [],
        skuIds: input.skuIds ?? [],
        productIds: input.productIds ?? [],
        categoryIds: input.categoryIds ?? [],
        customerId: input.customerId ?? null,
        campaignId: input.campaignId ?? null,
        allowStacking: input.allowStacking ?? false,
        priority: input.priority ?? 0,
        origin: 'manual',
        createdBy: context.userId,
      });
      if (id === undefined) {
        throw new PromoError('PROMO_CODE_TAKEN', `This brand already has the code ${code ?? ''}.`);
      }
      if (input.kind === 'tiered') {
        await repo.insertTiers(
          tx,
          context.orgId,
          id,
          (input.tiers ?? []).map((tier) => ({
            minSubtotalPoisha: BigInt(tier.minSubtotalPoisha),
            kind: tier.kind,
            valueBps: tier.kind === 'percent' ? (tier.valueBps ?? 0) : 0,
            valuePoisha: tier.kind === 'flat' ? BigInt(tier.valuePoisha ?? '0') : 0n,
          })),
        );
      }

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'promo.code.created',
        entityType: 'PromoCode',
        entityId: id,
        before: null,
        after: { code, method, kind: input.kind, title },
        requestId: context.requestId,
        request,
      });

      const saved = await repo.codeById(tx, context.orgId, id);
      if (saved === undefined) throw new Error('a code inserted in this transaction is gone');
      const tiers = await repo.tiersOf(tx, context.orgId, [id]);
      return toView(saved, tiers.get(id) ?? []);
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

/** The M35a columns at their M16 values: what every code the CRM issues still is. */
const M16_DEFAULTS = {
  method: 'code',
  description: '',
  buyQuantity: null,
  getQuantity: null,
  getDiscountBps: null,
  minOrderPoisha: null,
  minQuantity: null,
  firstOrderOnly: false,
  maxDiscountPoisha: null,
  startsAt: null,
  endsAt: null,
  channels: [],
  skuIds: [],
  productIds: [],
  categoryIds: [],
  campaignId: null,
  allowStacking: false,
  priority: 0,
} as const satisfies Partial<repo.NewPromoCode>;

/** A `timestamptz` from a raw query, which the driver hands back as text. */
export function instant(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function words(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** A stored row as the domain's engine reads it. Arrays arrive from `jsonb`. */
export function toDiscount(row: repo.PromoCodeRow, tiers: readonly repo.TierRow[]): Discount {
  return {
    id: row.id,
    method: row.method === 'automatic' ? 'automatic' : 'code',
    code: row.code,
    kind: row.kind as DiscountKind,
    valueBps: row.value_bps,
    valuePoisha: poisha(row.value_poisha),
    buyQuantity: row.buy_quantity ?? 0,
    getQuantity: row.get_quantity ?? 0,
    getDiscountBps: row.get_discount_bps ?? 10_000,
    tiers: tiers.map((tier) => ({
      minSubtotalPoisha: poisha(tier.min_subtotal_poisha),
      kind: tier.kind === 'flat' ? 'flat' : 'percent',
      valueBps: tier.value_bps,
      valuePoisha: poisha(tier.value_poisha),
    })),
    minOrderPoisha: row.min_order_poisha === null ? null : poisha(row.min_order_poisha),
    minQuantity: row.min_quantity,
    firstOrderOnly: row.first_order_only,
    maxDiscountPoisha: row.max_discount_poisha === null ? null : poisha(row.max_discount_poisha),
    totalLimit: row.total_limit,
    perCustomerLimit: row.per_customer_limit,
    validFrom: row.valid_from === null ? null : toIsoDate(row.valid_from),
    validTo: row.valid_to === null ? null : toIsoDate(row.valid_to),
    startsAt: instant(row.starts_at),
    endsAt: instant(row.ends_at),
    channels: words(row.channels),
    skuIds: words(row.sku_ids),
    productIds: words(row.product_ids),
    categoryIds: words(row.category_ids),
    customerId: row.customer_id,
    allowStacking: row.allow_stacking,
    priority: row.priority,
    status: row.status as Discount['status'],
  };
}

function toView(row: repo.PromoCodeRow, tiers: readonly repo.TierRow[]) {
  return {
    id: row.id,
    method: row.method,
    code: row.code,
    title: row.title,
    description: row.description,
    kind: row.kind,
    valueBps: row.value_bps,
    valuePoisha: row.value_poisha,
    buyQuantity: row.buy_quantity,
    getQuantity: row.get_quantity,
    getDiscountBps: row.get_discount_bps,
    tiers: tiers.map((tier) => ({
      minSubtotalPoisha: tier.min_subtotal_poisha,
      kind: tier.kind,
      valueBps: tier.value_bps,
      valuePoisha: tier.value_poisha,
    })),
    minOrderPoisha: row.min_order_poisha,
    minQuantity: row.min_quantity,
    firstOrderOnly: row.first_order_only,
    maxDiscountPoisha: row.max_discount_poisha,
    totalLimit: row.total_limit,
    perCustomerLimit: row.per_customer_limit,
    usedCount: row.used_count,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    startsAt: instant(row.starts_at)?.toISOString() ?? null,
    endsAt: instant(row.ends_at)?.toISOString() ?? null,
    channels: row.channels,
    skuIds: row.sku_ids,
    productIds: row.product_ids,
    categoryIds: row.category_ids,
    customerId: row.customer_id,
    campaignId: row.campaign_id,
    allowStacking: row.allow_stacking,
    priority: row.priority,
    origin: row.origin,
    status: row.status,
  };
}
