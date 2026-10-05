import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  availableForWeb,
  buildCategoryTree,
  buildNav,
  encodeStorefrontCursor,
  parseStorefrontQuery,
  searchTokens,
  storefrontPrice,
  visibleSubtreeIds,
  wireMoney,
  type CategoryNode,
  type CategoryTree,
  type StorefrontCursor,
  type StorefrontProductQuery,
} from '@elysium/domain/storefront';

import { serverEnv } from '../../platform/config/env.js';
import {
  CATALOG_API,
  type CatalogApi,
  type WebCard,
  type WebCategory,
  type WebFilter,
  type WebSku,
} from '../catalog/catalog.api.js';
import { FilesService, type PublicImage } from '../files/files.service.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { STOREFRONT_CONFIG, type StorefrontConfig } from './storefront.config.js';
import { StorefrontError } from './storefront.errors.js';
import * as repo from './storefront.repository.js';
import { StorefrontService, toDomainNav } from './storefront.service.js';

/**
 * What the brand's website reads (M33, D-506): the shop, a product, the categories, search,
 * the site's settings and a size chart, assembled from the catalog, inventory, files and this
 * module's own tables, each reached through its interface (invariant 12).
 *
 * Every answer here is built from named fields and then passed through the storefront
 * allow-list by the controller (`serializeForStorefront`), so nothing reaches the website
 * that was not put here on purpose. There is no cost anywhere in it: the catalog's selling
 * price is the only money, and the inventory read is quantities (invariant 5).
 *
 * Availability is live (D-503): on hand less reserved at the web locations, read on every
 * call and never cached by the server; the website may keep an answer for thirty seconds.
 */

type Variant = 'thumb' | 'card' | 'full';

export interface WireImage {
  readonly id: string;
  readonly alt: string | null;
  readonly width: number;
  readonly height: number;
  readonly urls: Readonly<Record<Variant, string>>;
}

interface CategoryRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

@Injectable()
export class StorefrontPublicService {
  constructor(
    @Inject(STOREFRONT_CONFIG) private readonly config: StorefrontConfig,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    private readonly files: FilesService,
    private readonly settings: StorefrontService,
  ) {}

  // --- the shop --------------------------------------------------------------------------------

  async products(orgId: string, params: Readonly<Record<string, string | undefined>>) {
    const { query, problems } = parseStorefrontQuery(params);
    if (problems.length > 0) {
      throw new StorefrontError(
        'VALIDATION_FAILED',
        HttpStatus.BAD_REQUEST,
        problems.map((problem) => problem.message).join(' '),
      );
    }
    return withOrg({ orgId }, async (tx) => {
      const categories = await this.catalog.webCategories(tx, orgId);
      const filter = this.filterOf(query, categories);
      const offset =
        query.cursor === null && query.page !== null ? (query.page - 1) * query.limit : 0;
      const [rows, total] = await Promise.all([
        this.catalog.webProductPage(tx, orgId, filter, {
          sort: query.sort,
          cursor: query.cursor,
          limit: query.limit + 1,
          offset,
        }),
        this.catalog.webProductCount(tx, orgId, filter),
      ]);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: await this.cards(tx, orgId, page, categories),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeStorefrontCursor(cursorAfter(query, last))
            : null,
        total,
        page: query.page,
        limit: query.limit,
      };
    });
  }

  /** Up to `limit` products for the search box, the shop's own rules, best first. */
  async search(orgId: string, q: string | undefined, limitText: string | undefined) {
    const words = searchTokens(q ?? '');
    const limit = Math.min(20, Math.max(1, Number.parseInt(limitText ?? '8', 10) || 8));
    if (words.length === 0) return { items: [] };
    return withOrg({ orgId }, async (tx) => {
      const categories = await this.catalog.webCategories(tx, orgId);
      const rows = await this.catalog.webProductPage(
        tx,
        orgId,
        { ...emptyFilter(), search: words },
        { sort: 'featured', cursor: null, limit, offset: 0 },
      );
      return { items: await this.cards(tx, orgId, rows, categories) };
    });
  }

  // --- one product -----------------------------------------------------------------------------

  async product(orgId: string, slug: string) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 200) return notFound();
    return withOrg({ orgId }, async (tx) => {
      const found = await this.catalog.webProductBySlug(tx, orgId, slug);
      if (found.kind === 'none') return notFound();
      if (found.kind === 'redirect') return { redirect: { slug: found.slug } };

      const product = found.product;
      const categories = await this.catalog.webCategories(tx, orgId);
      const [skus, images, webLocations, chart, relatedRows] = await Promise.all([
        this.catalog.webSkus(tx, orgId, [product.id]),
        this.catalog.webImages(tx, orgId, [product.id]),
        this.webLocations(tx, orgId),
        product.sizeChartId === null
          ? Promise.resolve(undefined)
          : repo.sizeChartById(tx, orgId, product.sizeChartId),
        product.categoryId === null
          ? Promise.resolve([] as WebCard[])
          : this.catalog.webProductPage(
              tx,
              orgId,
              { ...emptyFilter(), categoryIds: [product.categoryId], excludeIds: [product.id] },
              { sort: 'newest', cursor: null, limit: 4, offset: 0 },
            ),
      ]);
      const levels = await this.inventory.levelsAt(
        tx,
        orgId,
        skus.map((sku) => sku.id),
        webLocations,
      );
      const available = availableForWeb(levels, webLocations);
      const media = await this.files.publicImages(
        orgId,
        images.map((image) => image.fileId),
      );
      const card = this.card(orgId, product, skus, images, media, available, categories);

      return {
        product: {
          ...card,
          description: product.description,
          material: product.material,
          careInstructions: product.careInstructions,
          seoTitle: product.seoTitle,
          seoDescription: product.seoDescription,
          breadcrumb: breadcrumbOf(product.categoryId, categories),
          images: images
            .map((image) => this.image(orgId, image.fileId, image.altText, media))
            .filter((image): image is WireImage => image !== null),
          sizeChart:
            chart === undefined
              ? null
              : {
                  id: chart.id,
                  name: chart.name,
                  columns: chart.columns,
                  rows: Array.isArray(chart.rows) ? chart.rows : [],
                },
          variants: skus.map((sku) => {
            const price = storefrontPrice({ id: sku.id, pricePoisha: sku.pricePoisha as never });
            const qty = available.get(sku.id) ?? 0;
            return {
              skuId: sku.id,
              sku: sku.code,
              size: labelOf(sku, 'size'),
              colour: labelOf(sku, 'colour'),
              attributes: sku.values.map((value) => ({ name: value.name, value: value.label })),
              price: wireMoney(price.pricePoisha),
              compareAt: price.compareAtPoisha === null ? null : wireMoney(price.compareAtPoisha),
              availableQty: qty,
              inStock: qty > 0,
            };
          }),
          related: await this.cards(tx, orgId, relatedRows, categories),
        },
      };
    });
  }

  // --- categories, size charts, geography ------------------------------------------------------

  async categories(orgId: string) {
    return withOrg({ orgId }, async (tx) => {
      const categories = await this.catalog.webCategories(tx, orgId);
      const tree = buildCategoryTree(categories.map(toNode));
      const media = await this.files.publicImages(
        orgId,
        categories
          .map((category) => category.imageFileId)
          .filter((id): id is string => id !== null),
      );
      const byId = new Map(categories.map((category) => [category.id, category]));
      const shape = (node: CategoryTree<CategoryNode>): unknown => {
        const category = byId.get(node.id);
        return {
          id: node.id,
          slug: node.slug,
          name: node.name,
          description: category?.description ?? null,
          gender: category?.gender ?? null,
          featured: category?.featured ?? false,
          image:
            category?.imageFileId == null
              ? null
              : this.image(orgId, category.imageFileId, node.name, media),
          position: node.position,
          children: node.children.map(shape),
        };
      };
      return { items: tree.map(shape) };
    });
  }

  async sizeChart(orgId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();
    return withOrg({ orgId }, async (tx) => {
      const chart = await repo.sizeChartById(tx, orgId, id);
      if (chart === undefined) return notFound();
      return {
        sizeChart: {
          id: chart.id,
          name: chart.name,
          columns: chart.columns,
          rows: Array.isArray(chart.rows) ? chart.rows : [],
        },
      };
    });
  }

  async districts(orgId: string) {
    return withOrg({ orgId }, async (tx) => ({
      items: (await repo.districts(tx)).map((row) => ({
        id: row.id,
        divisionId: row.division_id,
        nameEn: row.name_en,
        nameBn: row.name_bn,
      })),
    }));
  }

  async thanas(orgId: string, districtText: string | undefined) {
    const districtId = districtText === undefined ? null : Number.parseInt(districtText, 10);
    if (
      districtText !== undefined &&
      (!/^\d{1,6}$/.test(districtText) || Number.isNaN(districtId))
    ) {
      throw new StorefrontError(
        'VALIDATION_FAILED',
        HttpStatus.BAD_REQUEST,
        'districtId is a district id.',
      );
    }
    return withOrg({ orgId }, async (tx) => ({
      items: (await repo.thanas(tx, districtId)).map((row) => ({
        id: row.id,
        districtId: row.district_id,
        nameEn: row.name_en,
        nameBn: row.name_bn,
      })),
    }));
  }

  // --- the site --------------------------------------------------------------------------------

  /** Settings, hero, menu, announcement, promo, testimonials, shipping and payment, in one. */
  async site(orgId: string) {
    return withOrg({ orgId }, async (tx) => {
      const [settings, slides, navRows, categories] = await Promise.all([
        this.settings.settingsIn(tx, orgId),
        repo.heroSlides(tx, orgId),
        repo.navItems(tx, orgId),
        this.catalog.webCategories(tx, orgId),
      ]);
      const active = slides.filter((slide) => slide.is_active);
      const media = await this.files.publicImages(orgId, [
        ...(settings.siteInfo.logoFileId === null ? [] : [settings.siteInfo.logoFileId]),
        ...active.flatMap((slide) =>
          slide.mobile_file_id === null
            ? [slide.desktop_file_id]
            : [slide.desktop_file_id, slide.mobile_file_id],
        ),
      ]);
      const info = settings.siteInfo;
      const shipping = settings.shipping;
      const zone = (key: 'inside_dhaka' | 'suburbs' | 'outside_dhaka') => ({
        fee: wireMoney(shipping.zones[key].feePoisha),
      });

      return {
        site: {
          name: info.siteName,
          logo:
            info.logoFileId === null
              ? null
              : this.image(orgId, info.logoFileId, info.siteName, media),
          whatsapp: info.whatsapp,
          phone: info.phone,
          email: info.email,
          address: info.address,
        },
        social: settings.social,
        announcement: settings.announcement,
        promoBanner: settings.promoBanner,
        testimonials: settings.testimonials,
        hero: active
          .map((slide) => {
            const desktop = this.image(orgId, slide.desktop_file_id, slide.alt_text, media);
            if (desktop === null) return null;
            return {
              id: slide.id,
              desktop,
              mobile:
                slide.mobile_file_id === null
                  ? null
                  : this.image(orgId, slide.mobile_file_id, slide.alt_text, media),
              link: slide.link,
              alt: slide.alt_text,
            };
          })
          .filter((slide) => slide !== null),
        menu: buildNav(navRows.map(toDomainNav), categories.map(toNode)),
        shipping: {
          freeShippingEnabled: shipping.freeShippingEnabled,
          freeShippingThreshold:
            shipping.freeShippingThresholdPoisha === null
              ? null
              : wireMoney(shipping.freeShippingThresholdPoisha),
          zones: {
            inside_dhaka: zone('inside_dhaka'),
            suburbs: zone('suburbs'),
            outside_dhaka: zone('outside_dhaka'),
          },
        },
        payments: settings.payments,
      };
    });
  }

  // --- assembly --------------------------------------------------------------------------------

  private async webLocations(tx: Tx, orgId: string): Promise<string[]> {
    return [...(await this.settings.settingsIn(tx, orgId)).webLocationIds];
  }

  private filterOf(query: StorefrontProductQuery, categories: readonly WebCategory[]): WebFilter {
    let categoryIds: string[] | null = null;
    if (query.category !== null) {
      const root = categories.find(
        (category) => category.id === query.category || category.slug === query.category,
      );
      categoryIds = root === undefined ? [] : visibleSubtreeIds(categories.map(toNode), root.id);
    }
    return {
      categoryIds,
      gender: query.gender,
      tags: query.tags,
      size: query.size,
      minPricePoisha: query.minPricePoisha,
      maxPricePoisha: query.maxPricePoisha,
      featured: query.featured,
      newArrival: query.newArrival,
      onSale: query.onSale,
      search: query.search,
    };
  }

  /** Cards for a page of products: their SKUs, images and live availability in three reads. */
  private async cards(
    tx: Tx,
    orgId: string,
    rows: readonly WebCard[],
    categories: readonly WebCategory[],
  ) {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [skus, images, webLocations] = await Promise.all([
      this.catalog.webSkus(tx, orgId, ids),
      this.catalog.webImages(tx, orgId, ids),
      this.webLocations(tx, orgId),
    ]);
    const levels = await this.inventory.levelsAt(
      tx,
      orgId,
      skus.map((sku) => sku.id),
      webLocations,
    );
    const available = availableForWeb(levels, webLocations);
    // A card shows two pictures at most (the second on hover, as the old shop did).
    const perProduct = new Map<string, (typeof images)[number][]>();
    for (const image of images) {
      const list = perProduct.get(image.productId) ?? [];
      if (list.length < 2) list.push(image);
      perProduct.set(image.productId, list);
    }
    const firstTwo = [...perProduct.values()].flat();
    const media = await this.files.publicImages(
      orgId,
      firstTwo.map((image) => image.fileId),
    );
    return rows.map((row) =>
      this.card(
        orgId,
        row,
        skus.filter((sku) => sku.productId === row.id),
        firstTwo.filter((image) => image.productId === row.id),
        media,
        available,
        categories,
      ),
    );
  }

  private card(
    orgId: string,
    row: WebCard,
    skus: readonly WebSku[],
    images: readonly { readonly fileId: string; readonly altText: string | null }[],
    media: ReadonlyMap<string, PublicImage>,
    available: ReadonlyMap<string, number>,
    categories: readonly WebCategory[],
  ) {
    const category = categories.find((candidate) => candidate.id === row.categoryId);
    const pictures = images
      .map((image) => this.image(orgId, image.fileId, image.altText ?? row.name, media))
      .filter((image): image is WireImage => image !== null);
    const sizes = sizesOf(skus);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      category: category === undefined ? null : refOf(category),
      gender: row.gender,
      tags: row.tags,
      featured: row.featured,
      newArrival: row.newArrival,
      price: { min: wireMoney(row.minPricePoisha), max: wireMoney(row.maxPricePoisha) },
      compareAt: null,
      onSale: false,
      image: pictures[0] ?? null,
      images: pictures.slice(0, 2),
      sizes,
      inStock: skus.some((sku) => (available.get(sku.id) ?? 0) > 0),
    };
  }

  /** An image as the website is told about it: absolute URLs for each size. */
  private image(
    orgId: string,
    fileId: string,
    alt: string | null,
    media: ReadonlyMap<string, PublicImage>,
  ): WireImage | null {
    const found = media.get(fileId);
    if (found === undefined) return null;
    const base = `${this.mediaBase()}/media/${orgId}/${fileId}`;
    const full = found.sizes.full ?? found.sizes.card ?? found.sizes.thumb;
    return {
      id: fileId,
      alt,
      width: full?.width ?? 0,
      height: full?.height ?? 0,
      urls: { thumb: `${base}/thumb`, card: `${base}/card`, full: `${base}/full` },
    };
  }

  private mediaBase(): string {
    return this.config.STOREFRONT_MEDIA_BASE_URL ?? serverEnv().API_PUBLIC_URL.replace(/\/+$/, '');
  }
}

function emptyFilter(): WebFilter {
  return {
    categoryIds: null,
    gender: null,
    tags: [],
    size: null,
    minPricePoisha: null,
    maxPricePoisha: null,
    featured: false,
    newArrival: false,
    onSale: false,
    search: [],
  };
}

function notFound(): never {
  throw new StorefrontError('NOT_FOUND', HttpStatus.NOT_FOUND, 'Not found.');
}

function toNode(category: WebCategory): CategoryNode {
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    slug: category.slug,
    position: category.position,
    visible: category.isActive && category.webVisible,
  };
}

function refOf(category: WebCategory): CategoryRef {
  return { id: category.id, slug: category.slug, name: category.name };
}

/** The path from the top of the tree down to this category, visible ones only. */
function breadcrumbOf(
  categoryId: string | null,
  categories: readonly WebCategory[],
): CategoryRef[] {
  const trail: CategoryRef[] = [];
  let current = categories.find((category) => category.id === categoryId);
  for (let hops = 0; current !== undefined && hops < 8; hops += 1) {
    if (!current.isActive || !current.webVisible) return [];
    trail.unshift(refOf(current));
    const parentId = current.parentId;
    current =
      parentId === null ? undefined : categories.find((category) => category.id === parentId);
  }
  return trail;
}

function labelOf(sku: WebSku, kind: string): string | null {
  return sku.values.find((value) => value.kind === kind)?.label ?? null;
}

/** The sizes a product comes in, in the size list's own order (S before M before L). */
function sizesOf(skus: readonly WebSku[]): string[] {
  const seen = new Map<string, number>();
  for (const sku of skus) {
    const size = sku.values.find((value) => value.kind === 'size');
    if (size !== undefined && !seen.has(size.label)) seen.set(size.label, size.position);
  }
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);
}

function cursorAfter(query: StorefrontProductQuery, last: WebCard): StorefrontCursor {
  switch (query.sort) {
    case 'newest':
    case 'oldest':
      return { sort: query.sort, createdAt: last.createdKey, id: last.id };
    case 'price-asc':
      return { sort: 'price-asc', pricePoisha: last.minPricePoisha.toString(), id: last.id };
    case 'price-desc':
      return { sort: 'price-desc', pricePoisha: last.maxPricePoisha.toString(), id: last.id };
    case 'featured':
      return { sort: 'featured', featured: last.featured, createdAt: last.createdKey, id: last.id };
    case 'name':
      return { sort: 'name', name: last.nameKey, id: last.id };
  }
}
