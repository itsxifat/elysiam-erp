import { randomInt } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { CampaignLinkInput } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  CAMPAIGN_LINK_CODE,
  campaignBasePath,
  campaignFullPath,
  campaignLinkCodeFrom,
} from '@elysium/domain/storefront';

import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { FilesService } from '../files/files.service.js';
import { StorefrontPublicService } from './storefront-public.service.js';
import { StorefrontError, storefrontInvalid, storefrontNotFound } from './storefront.errors.js';
import { StorefrontService } from './storefront.service.js';
import * as repo from './web-marketing.repository.js';

/** Draws before giving up: five digits leave 90,000 codes per brand. */
const CODE_TRIES = 40;

export interface Banner {
  readonly enabled: boolean;
  readonly text: string;
  readonly bgColor: string;
  readonly textColor: string;
  readonly link: string;
}

export interface Modal {
  readonly enabled: boolean;
  readonly type: 'text' | 'image';
  readonly title: string;
  readonly text: string;
  readonly imageFileId: string | null;
  readonly ctaText: string;
  readonly ctaLink: string;
}

const DEFAULT_BANNER: Banner = {
  enabled: false,
  text: '',
  bgColor: '#B85C3A',
  textColor: '#FFFFFF',
  link: '',
};
const DEFAULT_MODAL: Modal = {
  enabled: false,
  type: 'text',
  title: '',
  text: '',
  imageFileId: null,
  ctaText: '',
  ctaLink: '',
};

/** A stored section, read defensively: a malformed one is the default, never a crash. */
function bannerOf(value: unknown): Banner {
  return { ...DEFAULT_BANNER, ...(isRecord(value) ? (value as Partial<Banner>) : {}) };
}
function modalOf(value: unknown): Modal {
  return { ...DEFAULT_MODAL, ...(isRecord(value) ? (value as Partial<Modal>) : {}) };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Campaign links (M35b, D-551): the old site's custom URLs, run from the ERP.
 *
 * The console makes them (`Storefront`: org_admin and marketing); the website reads one by its
 * five-digit code through the signed API and counts a view with a second signed call. A link
 * names a category, the shop or a path of the website, the products to highlight, a banner
 * and a pop-up; the website renders the extras over its own listing.
 */
@Injectable()
export class CampaignLinksService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(FILES_API) private readonly filesApi: FilesApi,
    private readonly files: FilesService,
    private readonly settings: StorefrontService,
    private readonly publicService: StorefrontPublicService,
  ) {}

  // --- the console ----------------------------------------------------------------------------

  async list(context: ActiveContext) {
    return withOrg(context, async (tx) => {
      const [rows, categories, siteUrl] = await Promise.all([
        repo.customLinks(tx, context.orgId),
        this.catalog.webCategories(tx, context.orgId),
        this.siteUrl(tx, context.orgId),
      ]);
      const slugs = new Map(categories.map((category) => [category.id, category]));
      return {
        items: rows.map((row) => this.view(row, slugs, siteUrl)),
        siteUrl,
      };
    });
  }

  async get(context: ActiveContext, id: string) {
    return withOrg(context, async (tx) => {
      const row = await repo.customLinkById(tx, context.orgId, id);
      if (row === undefined) throw storefrontNotFound('campaign link');
      const categories = await this.catalog.webCategories(tx, context.orgId);
      return {
        link: this.view(
          row,
          new Map(categories.map((category) => [category.id, category])),
          await this.siteUrl(tx, context.orgId),
        ),
      };
    });
  }

  async create(context: ActiveContext, input: CampaignLinkInput) {
    return withOrg(context, async (tx) => {
      await this.assertRefs(tx, context.orgId, input);
      for (let attempt = 0; attempt < CODE_TRIES; attempt += 1) {
        const code = campaignLinkCodeFrom(randomInt(0, 2 ** 31 - 1));
        const id = await repo.insertCustomLink(tx, {
          ...values(input),
          orgId: context.orgId,
          code,
          actor: context.userId,
        });
        if (id !== null) return { id, code };
      }
      throw new StorefrontError(
        'CAMPAIGN_LINK_CODE_EXHAUSTED',
        HttpStatus.CONFLICT,
        'No free campaign code was found. Try again.',
      );
    });
  }

  async update(context: ActiveContext, id: string, input: CampaignLinkInput) {
    return withOrg(context, async (tx) => {
      await this.assertRefs(tx, context.orgId, input);
      const updated = await repo.updateCustomLink(tx, {
        ...values(input),
        orgId: context.orgId,
        id,
        actor: context.userId,
      });
      if (!updated) throw storefrontNotFound('campaign link');
      return { id };
    });
  }

  async remove(context: ActiveContext, id: string) {
    return withOrg(context, async (tx) => {
      if (!(await repo.deleteCustomLink(tx, context.orgId, id))) {
        throw storefrontNotFound('campaign link');
      }
      return { id };
    });
  }

  // --- the website ----------------------------------------------------------------------------

  /** A live link by code, as the website renders it (the old `/api/custom-url/[code]`). */
  async forWebsite(orgId: string, code: string) {
    if (!CAMPAIGN_LINK_CODE.test(code)) throw notFound();
    return withOrg({ orgId }, async (tx) => {
      const row = await repo.customLinkByCode(tx, orgId, code);
      if (row?.is_active !== true) throw notFound();
      const categories = await this.catalog.webCategories(tx, orgId);
      const category = categories.find((entry) => entry.id === row.category_id);
      const banner = bannerOf(row.banner);
      const modal = modalOf(row.modal);
      let modalImage = null;
      if (modal.enabled && modal.type === 'image' && modal.imageFileId !== null) {
        const media = await this.files.publicImagesIn(tx, orgId, [modal.imageFileId]);
        modalImage = this.publicService.image(orgId, modal.imageFileId, modal.title, media);
      }
      // Highlighted products the website still sells, in the order staff chose.
      const cards = await this.publicService.cardsByIds(tx, orgId, row.highlight_product_ids);
      return {
        customLink: {
          code: row.code,
          title: row.title,
          basePath: campaignBasePath({
            baseType: row.base_type,
            categorySlug: category?.slug ?? null,
            customPath: row.custom_path,
          }),
          banner: banner.enabled
            ? {
                text: banner.text,
                bgColor: banner.bgColor,
                textColor: banner.textColor,
                link: banner.link === '' ? null : banner.link,
              }
            : null,
          modal: modal.enabled
            ? {
                type: modal.type,
                title: modal.title,
                text: modal.text,
                image: modalImage,
                ctaText: modal.ctaText,
                ctaLink: modal.ctaLink === '' ? null : modal.ctaLink,
              }
            : null,
          highlightProducts: cards,
        },
      };
    });
  }

  /** One more view of a live link (the website's `POST …/views`). */
  async countView(orgId: string, code: string) {
    if (!CAMPAIGN_LINK_CODE.test(code)) throw notFound();
    const counted = await withOrg({ orgId }, (tx) => repo.countCustomLinkView(tx, orgId, code));
    if (!counted) throw notFound();
    return { ok: true };
  }

  // --- pieces ---------------------------------------------------------------------------------

  private async assertRefs(tx: Tx, orgId: string, input: CampaignLinkInput): Promise<void> {
    if (input.baseType === 'category' && input.categoryId !== null) {
      const categories = await this.catalog.webCategories(tx, orgId);
      if (!categories.some((category) => category.id === input.categoryId)) {
        throw storefrontNotFound('category');
      }
    }
    const unique = [...new Set(input.highlightProductIds)];
    if (unique.length !== input.highlightProductIds.length) {
      throw storefrontInvalid('A product is highlighted once.');
    }
    for (const productId of unique) {
      if ((await this.catalog.productWebFields(tx, orgId, productId)) === undefined) {
        throw storefrontNotFound('product');
      }
    }
    const image = input.modal.imageFileId;
    if (
      image !== null &&
      !(await this.filesApi.isPublicAsset(tx, orgId, image, 'campaign-asset'))
    ) {
      // Only a public campaign image may be put on the website (D-547's rule).
      throw storefrontInvalid('The pop-up image must be a public campaign image.');
    }
  }

  private async siteUrl(tx: Tx, orgId: string): Promise<string | null> {
    const settings = await this.settings.settingsIn(tx, orgId);
    const url = settings.siteInfo.siteUrl;
    return url === '' ? null : url.replace(/\/+$/, '');
  }

  private view(
    row: repo.CustomLinkRow,
    categories: ReadonlyMap<string, { readonly slug: string; readonly name: string }>,
    siteUrl: string | null,
  ) {
    const category = row.category_id === null ? undefined : categories.get(row.category_id);
    const basePath = campaignBasePath({
      baseType: row.base_type,
      categorySlug: category?.slug ?? null,
      customPath: row.custom_path,
    });
    const path = campaignFullPath(basePath, row.code);
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      baseType: row.base_type,
      categoryId: row.category_id,
      categoryName: category?.name ?? null,
      customPath: row.custom_path ?? '',
      highlightProductIds: row.highlight_product_ids,
      banner: bannerOf(row.banner),
      modal: modalOf(row.modal),
      isActive: row.is_active,
      views: Number(row.views),
      path,
      url: siteUrl === null ? null : `${siteUrl}${path}`,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}

function values(input: CampaignLinkInput): repo.CustomLinkValues {
  return {
    title: input.title,
    baseType: input.baseType,
    categoryId: input.baseType === 'category' ? input.categoryId : null,
    customPath: input.baseType === 'custom' ? input.customPath : null,
    highlightProductIds: input.highlightProductIds,
    banner: input.banner,
    modal: input.modal,
    isActive: input.isActive,
  };
}

function notFound(): StorefrontError {
  return new StorefrontError('NOT_FOUND', HttpStatus.NOT_FOUND, 'No such campaign link.');
}
