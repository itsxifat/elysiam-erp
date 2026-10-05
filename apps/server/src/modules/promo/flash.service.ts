import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { poisha, type Poisha } from '@elysium/domain';
import { flashSaleStatus, type FlashOffer } from '@elysium/domain/promo';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import type { FlashSaleBody } from './flash.schemas.js';
import * as repo from './flash.repository.js';
import { PromoError } from './promo.errors.js';
import { instant } from './promo.service.js';

/**
 * Flash sales (M35a, D-542): the console's editor, and the claims checkout makes.
 *
 * **What a claim promises.** `claim` runs in the order's own transaction, after the order
 * row exists and before it commits. Each line takes its units with one conditional UPDATE;
 * if any line is refused the whole claim throws `FLASH_SALE_UNAVAILABLE` and the caller's
 * transaction rolls back the order with every unit already taken. So an order either holds
 * every flash unit it was priced with, or does not exist.
 *
 * **What a release promises.** A cancelled or returned order gives its units back exactly
 * once: each claim row moves from `claimed` to `released` with a conditional UPDATE, and the
 * sale's sold count goes down by what that row released and nothing else.
 */

/** One line of an order priced by a flash offer: what the caller charged and for what. */
export interface FlashClaimLine {
  readonly skuId: string;
  readonly qty: number;
  readonly flashSaleItemId: string;
  /** The unit price the order charges; it must still be the offer's sale price. */
  readonly salePricePoisha: Poisha | bigint | string;
}

export interface FlashSkuView {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly variantLabel: string | null;
  readonly shelfPricePoisha: string;
}

@Injectable()
export class FlashService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly audit: AuditService,
  ) {}

  // --- the console ----------------------------------------------------------------------

  async list(context: ActiveContext, limit: number) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const now = new Date();
      const rows = await repo.listSales(tx, context.orgId, limit);
      return {
        items: rows.map((row) => ({
          ...saleView(row, now),
          skus: row.skus,
          unitsSold: row.units_sold,
          unitsOffered: row.units_offered,
        })),
      };
    });
  }

  async get(context: ActiveContext, id: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      this.detail(tx, context.orgId, id),
    );
  }

  async create(context: ActiveContext, request: AuditableRequest, body: FlashSaleBody) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      await this.assertItems(tx, context.orgId, body.items);
      const slug = body.slug ?? (await this.freeSlug(tx, context.orgId, body.title));
      const id = await repo.insertSale(tx, {
        orgId: context.orgId,
        ...terms(body),
        slug,
        createdBy: context.userId,
      });
      if (id === undefined) {
        throw new PromoError('FLASH_SALE_SLUG_TAKEN', `Another sale already uses ${slug}.`);
      }
      for (const item of body.items) await repo.upsertItem(tx, context.orgId, id, toItem(item));

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'promo.flash_sale.created',
        entityType: 'FlashSale',
        entityId: id,
        before: null,
        after: { title: body.title, slug, enabled: body.enabled, skus: body.items.length },
        requestId: context.requestId,
        request,
      });
      return this.detail(tx, context.orgId, id);
    });
  }

  /**
   * Make the stored sale match the editor: terms, prices and limits; SKUs left out are
   * switched off. What each SKU sold is carried, never taken from the request, so no edit
   * resets it; a limit below it is refused by the table's CHECK and reported as such.
   */
  async update(context: ActiveContext, request: AuditableRequest, id: string, body: FlashSaleBody) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.saleById(tx, context.orgId, id);
      if (before === undefined) throw new PromoError('FLASH_SALE_NOT_FOUND', 'No such sale.');
      await this.assertItems(tx, context.orgId, body.items);

      const slug = body.slug ?? before.slug;
      const outcome = await repo.updateSale(tx, context.orgId, id, { ...terms(body), slug });
      if (outcome === 'slug_taken') {
        throw new PromoError('FLASH_SALE_SLUG_TAKEN', `Another sale already uses ${slug}.`);
      }
      for (const item of body.items) await repo.upsertItem(tx, context.orgId, id, toItem(item));
      await repo.disableItemsExcept(
        tx,
        context.orgId,
        id,
        body.items.map((item) => item.skuId),
      );

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'promo.flash_sale.updated',
        entityType: 'FlashSale',
        entityId: id,
        before: { title: before.title, slug: before.slug, enabled: before.enabled },
        after: { title: body.title, slug, enabled: body.enabled, skus: body.items.length },
        requestId: context.requestId,
        request,
      });
      return this.detail(tx, context.orgId, id);
    });
  }

  async setEnabled(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    enabled: boolean,
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.saleById(tx, context.orgId, id);
      if (before === undefined) throw new PromoError('FLASH_SALE_NOT_FOUND', 'No such sale.');
      if (enabled) {
        const items = await repo.itemsOfSale(tx, context.orgId, id);
        if (!items.some((item) => item.enabled)) {
          throw new PromoError(
            'FLASH_SALE_INVALID',
            'Put at least one SKU on sale before switching the sale on.',
          );
        }
      }
      await repo.setSaleEnabled(tx, context.orgId, id, enabled);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'promo.flash_sale.enabled',
        entityType: 'FlashSale',
        entityId: id,
        before: { enabled: before.enabled },
        after: { enabled },
        requestId: context.requestId,
        request,
      });
      return this.detail(tx, context.orgId, id);
    });
  }

  /** A switched-off copy with the same terms and SKUs, nothing sold, and a slug of its own. */
  async duplicate(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const source = await repo.saleById(tx, context.orgId, id);
      if (source === undefined) throw new PromoError('FLASH_SALE_NOT_FOUND', 'No such sale.');
      const items = (await repo.itemsOfSale(tx, context.orgId, id)).filter((item) => item.enabled);
      const slug = await this.freeSlug(tx, context.orgId, source.slug);
      const copyId = await repo.insertSale(tx, {
        orgId: context.orgId,
        title: source.title,
        subtitle: source.subtitle,
        description: source.description,
        slug,
        bannerFileId: source.banner_file_id,
        enabled: false,
        showOnHome: source.show_on_home,
        priority: source.priority,
        startsAt: instant(source.starts_at),
        endsAt: instant(source.ends_at),
        createdBy: context.userId,
      });
      if (copyId === undefined) {
        throw new PromoError('FLASH_SALE_SLUG_TAKEN', `Another sale already uses ${slug}.`);
      }
      for (const item of items) {
        await repo.upsertItem(tx, context.orgId, copyId, {
          skuId: item.sku_id,
          salePricePoisha: BigInt(item.sale_price_poisha),
          unitLimit: item.unit_limit,
        });
      }
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'promo.flash_sale.duplicated',
        entityType: 'FlashSale',
        entityId: copyId,
        before: null,
        after: { from: id, slug },
        requestId: context.requestId,
        request,
      });
      return this.detail(tx, context.orgId, copyId);
    });
  }

  // --- checkout (through PromoApi) -------------------------------------------------------

  /**
   * Every switched-on offer on these SKUs that has not ended, as the domain ranks them.
   * Which one prices a line is `bestFlashOffer` / `planFlashLines` in `@elysium/domain/promo`.
   */
  async liveOffers(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
    now: Date,
  ): Promise<FlashOffer[]> {
    const rows = await repo.offersForSkus(tx, orgId, [...new Set(skuIds)], now);
    return rows.map((row) => ({
      flashSaleItemId: row.item_id,
      flashSaleId: row.sale_id,
      skuId: row.sku_id,
      salePricePoisha: poisha(row.sale_price_poisha),
      unitsLeft: row.unit_limit === null ? null : Math.max(0, row.unit_limit - row.units_sold),
      startsAt: instant(row.starts_at),
      endsAt: instant(row.ends_at),
      enabled: true,
      priority: row.priority,
    }));
  }

  /**
   * Take the flash units an order was priced with, all or nothing, in its transaction.
   *
   * Lines naming the same offer are taken together; offers are claimed in id order, so two
   * orders racing for the same offers lock them in the same order and cannot deadlock. A
   * second call for an order that already holds a claim on an offer takes nothing more for
   * it (a retried submission). Any refusal throws, naming the SKUs that could not be had.
   */
  async claim(
    tx: Tx,
    orgId: string,
    input: {
      readonly orderId: string;
      readonly lines: readonly FlashClaimLine[];
      readonly now: Date;
    },
  ): Promise<{ readonly claimIds: readonly string[] }> {
    const byItem = new Map<string, { skuId: string; qty: number; price: bigint }>();
    for (const line of input.lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw new PromoError('FLASH_SALE_INVALID', 'A flash line needs a whole quantity.');
      }
      const price = BigInt(line.salePricePoisha);
      const existing = byItem.get(line.flashSaleItemId);
      if (existing !== undefined && (existing.skuId !== line.skuId || existing.price !== price)) {
        throw new PromoError('FLASH_SALE_INVALID', 'One offer was given two prices or SKUs.');
      }
      byItem.set(line.flashSaleItemId, {
        skuId: line.skuId,
        qty: (existing?.qty ?? 0) + line.qty,
        price,
      });
    }

    const held = new Set(
      (await repo.heldClaims(tx, orgId, input.orderId)).map((claim) => claim.flash_sale_item_id),
    );

    /*
     * Inside a savepoint, so a refusal undoes every unit this call took even if the caller
     * catches the error and carries on in the same transaction (to price the line at the
     * shelf instead, say). All or nothing does not depend on the caller rolling back.
     */
    return tx.transaction(async (savepoint) => {
      const claimIds: string[] = [];
      const refused: string[] = [];
      for (const itemId of [...byItem.keys()].sort()) {
        const line = byItem.get(itemId);
        if (line === undefined || held.has(itemId)) continue;
        const took = await repo.claimUnits(savepoint, orgId, {
          itemId,
          skuId: line.skuId,
          qty: line.qty,
          salePricePoisha: line.price,
          now: input.now,
        });
        if (!took) {
          refused.push(line.skuId);
          continue;
        }
        const claimId = await repo.insertClaim(savepoint, {
          orgId,
          itemId,
          orderId: input.orderId,
          skuId: line.skuId,
          qty: line.qty,
          salePricePoisha: line.price,
        });
        if (claimId === undefined) {
          throw new Error('a flash claim for this order appeared mid-claim');
        }
        claimIds.push(claimId);
      }

      if (refused.length > 0) {
        throw new PromoError(
          'FLASH_SALE_UNAVAILABLE',
          'The flash price is no longer available for some of these items.',
          null,
          { skuIds: refused },
        );
      }
      return { claimIds };
    });
  }

  /**
   * Give an order's flash units back: all of them (a cancel), or up to the quantities
   * returned per SKU (a return after a partial delivery). Once: every claim row is
   * released by a conditional UPDATE and the sale's count moves by exactly what it released.
   * Returns the number of units given back.
   */
  async release(
    tx: Tx,
    orgId: string,
    orderId: string,
    returned?: readonly { readonly skuId: string; readonly qty: number }[],
  ): Promise<number> {
    const budget =
      returned === undefined
        ? undefined
        : returned.reduce(
            (map, line) => map.set(line.skuId, (map.get(line.skuId) ?? 0) + Math.max(0, line.qty)),
            new Map<string, number>(),
          );
    let units = 0;
    for (const claim of await repo.heldClaims(tx, orgId, orderId)) {
      const left = budget === undefined ? claim.qty : (budget.get(claim.sku_id) ?? 0);
      const give = Math.min(claim.qty, left);
      if (!(await repo.releaseClaim(tx, orgId, claim.id, give))) continue;
      if (budget !== undefined) budget.set(claim.sku_id, left - give);
      await repo.returnUnits(tx, orgId, claim.flash_sale_item_id, give);
      units += give;
    }
    return units;
  }

  // --- helpers ---------------------------------------------------------------------------

  private async detail(tx: Tx, orgId: string, id: string) {
    const sale = await repo.saleById(tx, orgId, id);
    if (sale === undefined) throw new PromoError('FLASH_SALE_NOT_FOUND', 'No such sale.');
    const items = await repo.itemsOfSale(tx, orgId, id);
    const skus = await this.skuViews(
      tx,
      orgId,
      items.map((item) => item.sku_id),
    );
    return {
      ...saleView(sale, new Date()),
      items: items.map((item) => ({
        id: item.id,
        ...(skus.get(item.sku_id) ?? unknownSku(item.sku_id)),
        salePricePoisha: item.sale_price_poisha,
        unitLimit: item.unit_limit,
        unitsSold: item.units_sold,
        enabled: item.enabled,
      })),
    };
  }

  /** Each SKU's code, product, size and colour, and selling price. Never a cost (invariant 5). */
  private async skuViews(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, FlashSkuView>> {
    const [skus, labels] = await Promise.all([
      this.catalog.skusByIds(tx, orgId, skuIds),
      this.catalog.variantLabels(tx, orgId, skuIds),
    ]);
    return new Map(
      skus.map((sku) => [
        sku.id,
        {
          skuId: sku.id,
          skuCode: sku.code,
          productId: sku.productId,
          productName: sku.productName,
          variantLabel: labels.get(sku.id) ?? null,
          shelfPricePoisha: sku.pricePoisha.toString(),
        },
      ]),
    );
  }

  /**
   * Every SKU is this brand's and sellable, and every sale price is below its shelf price:
   * an offer at or above the shelf price would never price anything (`rankFlashOffers`), so
   * saving one would only mislead whoever reads the sale.
   */
  private async assertItems(tx: Tx, orgId: string, items: FlashSaleBody['items']): Promise<void> {
    if (items.length === 0) return;
    const skus = new Map(
      (
        await this.catalog.skusByIds(
          tx,
          orgId,
          items.map((item) => item.skuId),
        )
      ).map((sku) => [sku.id, sku]),
    );
    for (const item of items) {
      const sku = skus.get(item.skuId);
      if (sku === undefined) {
        throw new PromoError('FLASH_SALE_INVALID', 'A SKU on the sale is not in this brand.');
      }
      if (BigInt(item.salePricePoisha) >= sku.pricePoisha) {
        throw new PromoError(
          'FLASH_SALE_INVALID',
          `The sale price of ${sku.code} has to be below its price.`,
          null,
          { skuId: sku.id },
        );
      }
    }
  }

  /** A slug from the title (or another slug) that no sale of this brand has yet. */
  private async freeSlug(tx: Tx, orgId: string, from: string): Promise<string> {
    const base = slugify(from);
    for (let n = 1; n <= 50; n += 1) {
      const candidate = n === 1 ? base : `${base.slice(0, 74)}-${String(n)}`;
      if (!(await repo.slugTaken(tx, orgId, candidate))) return candidate;
    }
    return `${base.slice(0, 70)}-${randomBytes(4).toString('hex')}`;
  }
}

/** Lower-case latin words joined by dashes; a title with none (Bangla, say) is `flash-sale`. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug === '' ? 'flash-sale' : slug;
}

function terms(body: FlashSaleBody) {
  return {
    title: body.title,
    subtitle: body.subtitle,
    description: body.description,
    bannerFileId: body.bannerFileId,
    enabled: body.enabled,
    showOnHome: body.showOnHome,
    priority: body.priority,
    startsAt: body.startsAt === null ? null : new Date(body.startsAt),
    endsAt: body.endsAt === null ? null : new Date(body.endsAt),
  };
}

function toItem(item: FlashSaleBody['items'][number]) {
  return {
    skuId: item.skuId,
    salePricePoisha: BigInt(item.salePricePoisha),
    unitLimit: item.unitLimit,
  };
}

function unknownSku(skuId: string): FlashSkuView {
  return {
    skuId,
    skuCode: '',
    productId: '',
    productName: '',
    variantLabel: null,
    shelfPricePoisha: '0',
  };
}

function saleView(row: repo.FlashSaleRow, now: Date) {
  const startsAt = instant(row.starts_at);
  const endsAt = instant(row.ends_at);
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    slug: row.slug,
    bannerFileId: row.banner_file_id,
    enabled: row.enabled,
    showOnHome: row.show_on_home,
    priority: row.priority,
    startsAt: startsAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
    status: flashSaleStatus({ enabled: row.enabled, startsAt, endsAt }, now),
    createdAt: instant(row.created_at)?.toISOString() ?? null,
    updatedAt: instant(row.updated_at)?.toISOString() ?? null,
  };
}
