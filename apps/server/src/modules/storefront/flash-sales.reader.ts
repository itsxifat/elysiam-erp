import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { wireMoney } from '@elysium/domain/storefront';

import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { FilesService } from '../files/files.service.js';
import { PROMO_API, type PromoApi } from '../promo/promo.api.js';
import type { StorefrontFlashSale } from '../promo/flash.service.js';
import { StorefrontError } from './storefront.errors.js';
import { StorefrontPublicService } from './storefront-public.service.js';

/**
 * The website's flash-sale pages (M34, D-548): `GET /storefront/v1/flash-sales` and `/:slug`.
 *
 * The promo module says which sales are switched on and which of their SKUs are switched on;
 * what the website may show is the storefront's to decide (M35a's ledger audit W1): only SKUs
 * the website sells now — an active SKU of an active product shown on the website — and a sale
 * left with none is not shown at all. A scheduled sale is shown (the old site's "coming soon")
 * **without its prices** until it starts (D-538): a price staff may still change is not a
 * promise the website should print. Money leaves as `{ poisha, taka }` strings.
 */
@Injectable()
export class FlashSalesReader {
  constructor(
    @Inject(PROMO_API) private readonly promo: PromoApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly files: FilesService,
    private readonly pages: StorefrontPublicService,
  ) {}

  async list(orgId: string, homeOnly: boolean) {
    return withOrg({ orgId }, async (tx) => {
      const sales = await this.promo.storefrontFlashSales(tx, orgId, { now: new Date(), homeOnly });
      return { items: await this.render(tx, orgId, sales) };
    });
  }

  async one(orgId: string, slug: string) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 120) throw notFound();
    return withOrg({ orgId }, async (tx) => {
      const sale = await this.promo.storefrontFlashSale(tx, orgId, slug, new Date());
      if (sale === undefined) throw notFound();
      const [shown] = await this.render(tx, orgId, [sale]);
      if (shown === undefined) throw notFound();
      return { flashSale: shown };
    });
  }

  private async render(tx: Tx, orgId: string, sales: readonly StorefrontFlashSale[]) {
    const skuIds = [...new Set(sales.flatMap((sale) => sale.items.map((item) => item.skuId)))];
    const facts = new Map(
      (await this.catalog.webSkuFacts(tx, orgId, skuIds))
        .filter((fact) => fact.sellable)
        .map((fact) => [fact.id, fact]),
    );
    const productIds = [...new Set([...facts.values()].map((fact) => fact.productId))];
    const images = await this.catalog.webImages(tx, orgId, productIds);
    const firstImage = new Map<string, { fileId: string; altText: string | null }>();
    for (const image of images) {
      if (!firstImage.has(image.productId)) firstImage.set(image.productId, image);
    }
    const media = await this.files.publicImagesIn(tx, orgId, [
      ...[...firstImage.values()].map((image) => image.fileId),
      ...sales.flatMap((sale) => (sale.bannerFileId === null ? [] : [sale.bannerFileId])),
    ]);

    return sales.flatMap((sale) => {
      const priced = sale.status === 'live';
      const items = sale.items.flatMap((item) => {
        const fact = facts.get(item.skuId);
        if (fact === undefined) return [];
        const image = firstImage.get(fact.productId);
        const label = (kind: string) =>
          fact.values.find((value) => value.kind === kind)?.label ?? null;
        return [
          {
            skuId: item.skuId,
            sku: fact.code,
            product: { id: fact.productId, slug: fact.productSlug, name: fact.productName },
            size: label('size'),
            colour: label('colour'),
            price: priced ? wireMoney(poisha(item.salePricePoisha)) : null,
            compareAt: wireMoney(poisha(fact.pricePoisha)),
            unitsLeft: item.unitsLeft,
            image:
              image === undefined
                ? null
                : this.pages.image(orgId, image.fileId, image.altText ?? fact.productName, media),
          },
        ];
      });
      if (items.length === 0) return [];
      return [
        {
          id: sale.id,
          slug: sale.slug,
          title: sale.title,
          subtitle: sale.subtitle,
          description: sale.description,
          status: sale.status,
          startsAt: sale.startsAt?.toISOString() ?? null,
          endsAt: sale.endsAt?.toISOString() ?? null,
          showOnHome: sale.showOnHome,
          banner:
            sale.bannerFileId === null
              ? null
              : this.pages.image(orgId, sale.bannerFileId, sale.title, media),
          items,
        },
      ];
    });
  }
}

function notFound(): StorefrontError {
  return new StorefrontError('NOT_FOUND', HttpStatus.NOT_FOUND, 'Not found.');
}
