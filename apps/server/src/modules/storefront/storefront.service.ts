import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  siteInfoSchema,
  type CategoryWebFieldsInput,
  type HeroSlideInput,
  type NavItemInput,
  type ProductWebFieldsInput,
  type SizeChartInput,
  type StorefrontSettingsPatch,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import {
  navProblems,
  normaliseTags,
  shippingRuleProblems,
  sizeChartProblems,
  type NavItemRow as DomainNavItem,
} from '@elysium/domain/storefront';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi, type Change } from '../catalog/catalog.api.js';
import type { FilePurpose } from '../files/files.policy.js';
import { FilesService } from '../files/files.service.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { STOREFRONT_CONFIG, type StorefrontConfig } from './storefront.config.js';
import { StorefrontError, storefrontInvalid, storefrontNotFound } from './storefront.errors.js';
import * as repo from './storefront.repository.js';
import {
  defaultSettings,
  settingsFromRow,
  type StorefrontSettings,
} from './storefront.settings.js';
import { SiteCache } from './site-cache.js';
import { deriveStorefrontSecret, fingerprint, newKeyId } from './signature.js';
import * as refs from './references.repository.js';

/**
 * Website → Settings, Hero slides, Menu, Size charts and Connection, and the website fields on
 * the product page and Catalog setup (M33, D-500 to D-506).
 *
 * Orchestration only: the rules (tags, links, the menu's shape, the shipping rule, size
 * charts) are the domain's, and the catalog's and the order desk's tables are reached
 * through `CATALOG_API` and `ORDERS_API` (invariant 12). Every write invalidates the website's
 * cached `site` answer in this process; other processes' copies expire within thirty seconds.
 */

export interface SettingsView extends StorefrontSettings {
  readonly options: {
    readonly locations: readonly {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly kind: string;
      readonly isActive: boolean;
    }[];
    readonly deliveryZones: readonly {
      readonly id: string;
      readonly code: string;
      readonly nameEn: string;
      readonly nameBn: string;
      readonly chargePoisha: string;
      readonly isActive: boolean;
    }[];
  };
  readonly updatedAt: string | null;
}

/**
 * Who writes the website's settings and keys: a person at the console (an `ActiveContext`
 * fits), or the operator's command on the server, recorded as a system actor
 * (`main.admin.ts`, D-582).
 */
export interface StorefrontActor {
  readonly orgId: string;
  readonly userId: string;
  readonly requestId?: string | undefined;
}

/** How a write arrived when it was not the console: recorded on its audit row (D-582). */
export type StorefrontWriteVia = 'cli';

function change<T>(present: boolean, value: T): Change<T> {
  return present ? { set: true, value } : undefined;
}

@Injectable()
export class StorefrontService {
  constructor(
    @Inject(STOREFRONT_CONFIG) private readonly config: StorefrontConfig,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly files: FilesService,
    private readonly cache: SiteCache,
    private readonly audit: AuditService,
  ) {}

  // --- settings -------------------------------------------------------------------------------

  /** The settings as stored over the defaults, inside the caller's transaction. */
  async settingsIn(tx: Tx, orgId: string): Promise<StorefrontSettings> {
    const [row, locations, zones, name, chosen] = await Promise.all([
      repo.settingsOf(tx, orgId),
      repo.sellingLocations(tx, orgId),
      this.orders.deliveryZones(tx, orgId),
      repo.orgName(tx, orgId),
      repo.webLocationIds(tx, orgId),
    ]);
    // The brand's first active warehouse, the order desk's own default (D-172).
    const warehouse = locations.find(
      (location) => location.kind === 'warehouse' && location.is_active,
    );
    const defaults = defaultSettings({
      siteName: name ?? '',
      zones,
      defaultLocationId: warehouse?.id ?? null,
    });
    return settingsFromRow(row, defaults, chosen);
  }

  async getSettings(context: ActiveContext): Promise<SettingsView> {
    return withOrg(context, async (tx) => this.view(tx, context.orgId));
  }

  private async view(tx: Tx, orgId: string): Promise<SettingsView> {
    const [settings, row, locations, zones] = await Promise.all([
      this.settingsIn(tx, orgId),
      repo.settingsOf(tx, orgId),
      repo.sellingLocations(tx, orgId),
      this.orders.deliveryZones(tx, orgId),
    ]);
    return {
      ...settings,
      options: {
        locations: locations.map((location) => ({
          id: location.id,
          code: location.code,
          name: location.name,
          kind: location.kind,
          isActive: location.is_active,
        })),
        deliveryZones: zones.map((zone) => ({
          id: zone.id,
          code: zone.code,
          nameEn: zone.nameEn,
          nameBn: zone.nameBn,
          chargePoisha: zone.chargePoisha.toString(),
          isActive: zone.isActive,
        })),
      },
      updatedAt: row === undefined ? null : iso(row.updated_at),
    };
  }

  /**
   * Save the sections sent; the rest stay as they are. Audited inside the write, with what a
   * shopper is charged written out under names the audit's redaction leaves alone (ledger
   * audit M1: a key named `shipping` matches the `pin` pattern and was stored redacted).
   */
  async patchSettings(
    context: StorefrontActor,
    request: AuditableRequest,
    patch: StorefrontSettingsPatch,
  ): Promise<SettingsView> {
    return this.saveSettings(context, request, () => patch);
  }

  /**
   * Website → Settings' Site URL alone, from the operator's `website-site-url` on the server
   * (D-582). The rest of the site details are read inside the save's lock and kept, so a
   * console save at the same moment is not overwritten with what was read before it; then
   * saved and audited as a console save is, with `via` on the audit row. The address is
   * `normaliseSiteUrl`'s.
   */
  async setSiteUrl(
    context: StorefrontActor,
    siteUrl: string,
    via: StorefrontWriteVia,
  ): Promise<SettingsView> {
    const value = normaliseSiteUrl(siteUrl);
    return this.saveSettings(
      context,
      undefined,
      (current) => ({ siteInfo: { ...current.siteInfo, siteUrl: value } }),
      via,
    );
  }

  private async saveSettings(
    context: StorefrontActor,
    request: AuditableRequest | undefined,
    patchOf: (current: StorefrontSettings) => StorefrontSettingsPatch,
    via?: StorefrontWriteVia,
  ): Promise<SettingsView> {
    const result = await withOrg(context, async (tx) => {
      await repo.lockSettings(tx, context.orgId);
      const current = await this.settingsIn(tx, context.orgId);
      const patch = patchOf(current);
      const next: StorefrontSettings = { ...current, ...patch };

      if (patch.siteInfo !== undefined && patch.siteInfo.logoFileId !== null) {
        await this.assertPublicImages(tx, context.orgId, [patch.siteInfo.logoFileId], 'logo');
      }
      if (patch.shipping !== undefined) {
        const zones = await this.orders.deliveryZones(tx, context.orgId);
        const problems = shippingRuleProblems(
          {
            freeShippingEnabled: patch.shipping.freeShippingEnabled,
            freeShippingThresholdPoisha:
              patch.shipping.freeShippingThresholdPoisha === null
                ? null
                : poisha(patch.shipping.freeShippingThresholdPoisha),
            zones: {
              inside_dhaka: this.zoneRule(patch.shipping.zones.inside_dhaka),
              suburbs: this.zoneRule(patch.shipping.zones.suburbs),
              outside_dhaka: this.zoneRule(patch.shipping.zones.outside_dhaka),
            },
          },
          zones.map((zone) => zone.id),
        );
        if (problems.length > 0) {
          throw storefrontInvalid(
            problems.some((problem) => problem.code === 'ZONE_IN_TWO_PLACES')
              ? 'A delivery zone can belong to one website zone only.'
              : problems.some((problem) => problem.code === 'ZONE_UNKNOWN')
                ? 'A delivery zone in the shipping rule is not one of this brand’s.'
                : 'A shipping fee or threshold is out of range.',
          );
        }
      }
      if (patch.webLocationIds !== undefined) {
        const locations = await repo.sellingLocations(tx, context.orgId);
        const usable = new Set(locations.filter((row) => row.is_active).map((row) => row.id));
        if (patch.webLocationIds.some((id) => !usable.has(id))) {
          throw storefrontInvalid(
            'The website sells only from this brand’s active warehouses and showrooms.',
          );
        }
        await repo.replaceWebLocations(tx, context.orgId, [...new Set(patch.webLocationIds)]);
      }

      const { siteName, logoFileId, ...info } = next.siteInfo;
      await repo.upsertSettings(tx, context.orgId, {
        siteName,
        logoFileId,
        siteInfo: info,
        social: next.social,
        announcement: next.announcement,
        promoBanner: next.promoBanner,
        testimonials: next.testimonials,
        shipping: next.shipping,
        payments: next.payments,
        updatedBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'storefront.settings_updated',
        entityType: 'storefront.settings',
        entityId: context.orgId,
        before: auditSummary(current),
        after: {
          sections: Object.keys(patch),
          ...auditSummary(next),
          ...(via === undefined ? {} : { via }),
        },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return this.view(tx, context.orgId);
    });
    this.cache.forget(context.orgId);
    return result;
  }

  private zoneRule(zone: {
    readonly feePoisha: string;
    readonly deliveryZoneIds: readonly string[];
  }) {
    return { feePoisha: poisha(zone.feePoisha), deliveryZoneIds: zone.deliveryZoneIds };
  }

  // --- hero slides ----------------------------------------------------------------------------

  async listHeroSlides(context: ActiveContext) {
    return withOrg(context, async (tx) => ({
      items: (await repo.heroSlides(tx, context.orgId)).map(heroView),
    }));
  }

  async createHeroSlide(context: ActiveContext, input: HeroSlideInput) {
    const row = await withOrg(context, async (tx) => {
      await this.assertPublicImages(
        tx,
        context.orgId,
        [input.desktopFileId, input.mobileFileId].filter((id): id is string => id !== null),
        'slide image',
      );
      return repo.insertHeroSlide(tx, context.orgId, input);
    });
    this.cache.forget(context.orgId);
    return heroView(row);
  }

  async updateHeroSlide(context: ActiveContext, id: string, input: HeroSlideInput) {
    const row = await withOrg(context, async (tx) => {
      await this.assertPublicImages(
        tx,
        context.orgId,
        [input.desktopFileId, input.mobileFileId].filter(
          (value): value is string => value !== null,
        ),
        'slide image',
      );
      return repo.updateHeroSlide(tx, context.orgId, id, input);
    });
    if (row === undefined) throw storefrontNotFound('slide');
    this.cache.forget(context.orgId);
    return heroView(row);
  }

  async deleteHeroSlide(context: ActiveContext, id: string, request?: AuditableRequest) {
    const deleted = await withOrg(context, async (tx) => {
      // M39a (D-622): the slide's content goes into the audit log in the same transaction.
      const before = await refs.heroSlideImage(tx, context.orgId, id);
      if (!(await repo.deleteHeroSlide(tx, context.orgId, id))) return false;
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'storefront.hero_slide.deleted',
        entityType: 'HeroSlide',
        entityId: id,
        before: before ?? null,
        after: null,
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return true;
    });
    if (!deleted) throw storefrontNotFound('slide');
    this.cache.forget(context.orgId);
    return { id };
  }

  async reorderHeroSlides(context: ActiveContext, ids: readonly string[]) {
    const result = await withOrg(context, async (tx) => {
      const current = await repo.heroSlides(tx, context.orgId);
      if (ids.length !== current.length || current.some((row) => !ids.includes(row.id))) {
        throw storefrontInvalid('Send every slide exactly once, in the order they should play.');
      }
      await repo.reorderHeroSlides(tx, context.orgId, ids);
      return { items: (await repo.heroSlides(tx, context.orgId)).map(heroView) };
    });
    this.cache.forget(context.orgId);
    return result;
  }

  // --- the menu -------------------------------------------------------------------------------

  async listNav(context: ActiveContext) {
    return withOrg(context, async (tx) => {
      const [items, categories] = await Promise.all([
        repo.navItems(tx, context.orgId),
        this.catalog.webCategories(tx, context.orgId),
      ]);
      return {
        items: items.map(navView),
        categories: categories.map((category) => ({
          id: category.id,
          parentId: category.parentId,
          name: category.name,
          slug: category.slug,
          isActive: category.isActive,
          webVisible: category.webVisible,
        })),
      };
    });
  }

  async createNavItem(context: ActiveContext, input: NavItemInput) {
    const row = await withOrg(context, async (tx) => {
      await repo.lockNav(tx, context.orgId);
      const created = await repo.insertNavItem(tx, context.orgId, input);
      await this.assertMenuShape(tx, context.orgId);
      return created;
    });
    this.cache.forget(context.orgId);
    return navView(row);
  }

  async updateNavItem(context: ActiveContext, id: string, input: NavItemInput) {
    const row = await withOrg(context, async (tx) => {
      await repo.lockNav(tx, context.orgId);
      const updated = await repo.updateNavItem(tx, context.orgId, id, input);
      if (updated === undefined) throw storefrontNotFound('menu item');
      await this.assertMenuShape(tx, context.orgId);
      return updated;
    });
    this.cache.forget(context.orgId);
    return navView(row);
  }

  async deleteNavItem(context: ActiveContext, id: string, request?: AuditableRequest) {
    const deleted = await withOrg(context, async (tx) => {
      await repo.lockNav(tx, context.orgId);
      // M39a (D-622, D-628): a dropdown takes its items with it (0103's cascade), so the
      // audit row keeps the item and every item that went with it.
      const { item, children } = await refs.navItemWithChildren(tx, context.orgId, id);
      if (!(await repo.deleteNavItem(tx, context.orgId, id))) return false;
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'storefront.nav_item.deleted',
        entityType: 'NavItem',
        entityId: id,
        before: { ...item, children: children.map((child) => ({ ...child })) },
        after: null,
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return true;
    });
    if (!deleted) throw storefrontNotFound('menu item');
    this.cache.forget(context.orgId);
    return { id };
  }

  /** The whole menu's order and nesting after a drag, every item exactly once. */
  async layoutNav(
    context: ActiveContext,
    items: readonly {
      readonly id: string;
      readonly parentId: string | null;
      readonly position: number;
    }[],
  ) {
    const result = await withOrg(context, async (tx) => {
      await repo.lockNav(tx, context.orgId);
      const current = await repo.navItems(tx, context.orgId);
      const sent = new Set(items.map((item) => item.id));
      if (items.length !== current.length || current.some((row) => !sent.has(row.id))) {
        throw storefrontInvalid('Send every menu item exactly once.');
      }
      await repo.layoutNav(tx, context.orgId, items);
      await this.assertMenuShape(tx, context.orgId);
      return { items: (await repo.navItems(tx, context.orgId)).map(navView) };
    });
    this.cache.forget(context.orgId);
    return result;
  }

  /** The domain's menu rules over the rows as they now stand, inside the write. */
  private async assertMenuShape(tx: Tx, orgId: string): Promise<void> {
    const rows = await repo.navItems(tx, orgId);
    const problems = navProblems(rows.map(toDomainNav));
    if (problems.length > 0) throw storefrontInvalid(problems[0] ?? 'That menu is not valid.');
  }

  // --- size charts ----------------------------------------------------------------------------

  async listSizeCharts(context: ActiveContext) {
    return withOrg(context, async (tx) => ({
      items: (await repo.sizeCharts(tx, context.orgId)).map(chartView),
    }));
  }

  async createSizeChart(context: ActiveContext, input: SizeChartInput) {
    assertChart(input);
    const row = await withOrg(context, (tx) => repo.insertSizeChart(tx, context.orgId, input));
    return chartView(row);
  }

  async updateSizeChart(context: ActiveContext, id: string, input: SizeChartInput) {
    assertChart(input);
    const row = await withOrg(context, (tx) => repo.updateSizeChart(tx, context.orgId, id, input));
    if (row === undefined) throw storefrontNotFound('size chart');
    return chartView(row);
  }

  async deleteSizeChart(context: ActiveContext, id: string, request?: AuditableRequest) {
    await withOrg(context, async (tx) => {
      // Locked first, so a product given this chart at the same moment either is counted
      // or waits and then fails on its foreign key (M39a, D-621).
      const chart = await refs.lockSizeChart(tx, context.orgId, id);
      if (chart === undefined) throw storefrontNotFound('size chart');
      const using = await this.catalog.sizeChartProducts(tx, context.orgId, id);
      if (using.count > 0) {
        const named = using.examples.map((example) => example.label).join(', ');
        throw new StorefrontError(
          'STOREFRONT_IN_USE',
          HttpStatus.CONFLICT,
          `${String(using.count)} product${using.count === 1 ? ' uses' : 's use'} this size chart (${named}${using.count > using.examples.length ? ', …' : ''}). Use Empty and delete to give them another chart, or none.`,
        );
      }
      await refs.forgetLegacyIds(tx, context.orgId, 'size_chart', [id]);
      if (!(await repo.deleteSizeChart(tx, context.orgId, id)))
        throw storefrontNotFound('size chart');
      // M39a (D-622): the chart's grid goes into the audit log in the same transaction.
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'storefront.size_chart.deleted',
        entityType: 'SizeChart',
        entityId: id,
        before: { ...chart },
        after: null,
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });
    this.cache.forget(context.orgId);
    return { id };
  }

  // --- the website's keys ---------------------------------------------------------------------

  async listKeys(context: ActiveContext) {
    return withOrg(context, async (tx) => ({
      items: (await repo.siteKeys(tx, context.orgId)).map(keyView),
      configured: this.config.INTAKE_KEY_SECRET !== undefined,
    }));
  }

  /**
   * Issue a key. The secret is in this response and in no other, ever. The console's
   * Website → Connection and the operator's `website-key` on the server (D-582, `via: 'cli'`)
   * both come here, so a key is the same whichever issued it.
   */
  async issueKey(
    context: StorefrontActor,
    request: AuditableRequest | undefined,
    label: string,
    via?: StorefrontWriteVia,
  ) {
    const master = this.config.INTAKE_KEY_SECRET;
    if (master === undefined) {
      throw new StorefrontError(
        'SERVICE_UNAVAILABLE',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Website keys cannot be issued until the server’s key secret is configured.',
      );
    }
    const keyId = newKeyId(context.orgId);
    const secret = deriveStorefrontSecret(master, keyId);
    const row = await withOrg(context, async (tx) => {
      const inserted = await repo.insertSiteKey(tx, context.orgId, {
        label,
        keyId,
        secretSha256: fingerprint(secret),
        createdBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'storefront.site_key_issued',
        entityType: 'storefront.site_key',
        entityId: inserted.id,
        // The key id is public; the secret is not in here, under any name.
        after: { label, keyId, ...(via === undefined ? {} : { via }) },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
      return inserted;
    });
    // Audited inside the write with the public key id; the secret is in this response only.
    return { ...keyView(row), secret };
  }

  async revokeKey(context: ActiveContext, request: AuditableRequest, id: string) {
    const row = await withOrg(context, async (tx) => {
      const revoked = await repo.revokeSiteKey(tx, context.orgId, id, context.userId);
      if (revoked !== undefined) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'storefront.site_key_revoked',
          entityType: 'storefront.site_key',
          entityId: id,
          after: { keyId: revoked.key_id },
          requestId: context.requestId,
          request,
        });
        return revoked;
      }
      const existing = await repo.siteKeyById(tx, context.orgId, id);
      if (existing === undefined) throw storefrontNotFound('key');
      return existing;
    });
    return keyView(row);
  }

  // --- website fields on products and categories ----------------------------------------------

  async setProductWebFields(
    context: ActiveContext,
    productId: string,
    input: ProductWebFieldsInput,
  ) {
    const fields = await withOrg(context, async (tx) => {
      if (input.sizeChartId !== undefined && input.sizeChartId !== null) {
        const chart = await repo.sizeChartById(tx, context.orgId, input.sizeChartId);
        if (chart === undefined) throw storefrontNotFound('size chart');
      }
      const saved = await this.catalog.setProductWebFields(tx, context.orgId, productId, {
        webVisible: change(input.webVisible !== undefined, input.webVisible ?? false),
        featured: change(input.featured !== undefined, input.featured ?? false),
        newArrival: change(input.newArrival !== undefined, input.newArrival ?? false),
        gender: change(input.gender !== undefined, input.gender ?? null),
        material: change(input.material !== undefined, blankToNull(input.material)),
        careInstructions: change(
          input.careInstructions !== undefined,
          blankToNull(input.careInstructions),
        ),
        tags: change(input.tags !== undefined, normaliseTags(input.tags ?? [])),
        sizeChartId: change(input.sizeChartId !== undefined, input.sizeChartId ?? null),
        seoTitle: change(input.seoTitle !== undefined, blankToNull(input.seoTitle)),
        seoDescription: change(
          input.seoDescription !== undefined,
          blankToNull(input.seoDescription),
        ),
      });
      if (saved === undefined) throw storefrontNotFound('product');
      return saved;
    });
    return { productId, web: fields };
  }

  async setCategoryWebFields(
    context: ActiveContext,
    categoryId: string,
    input: CategoryWebFieldsInput,
  ) {
    const category = await withOrg(context, async (tx) => {
      if (input.imageFileId !== undefined && input.imageFileId !== null) {
        await this.assertPublicImages(tx, context.orgId, [input.imageFileId], 'category picture', [
          'category-image',
        ]);
      }
      const saved = await this.catalog.setCategoryWebFields(tx, context.orgId, categoryId, {
        webVisible: change(input.webVisible !== undefined, input.webVisible ?? true),
        featured: change(input.featured !== undefined, input.featured ?? false),
        gender: change(input.gender !== undefined, input.gender ?? null),
        description: change(input.description !== undefined, blankToNull(input.description)),
        imageFileId: change(input.imageFileId !== undefined, input.imageFileId ?? null),
      });
      if (saved === undefined) throw storefrontNotFound('category');
      return saved;
    });
    this.cache.forget(context.orgId);
    return category;
  }

  // --- helpers --------------------------------------------------------------------------------

  /**
   * Every id names a stored, public website image of this brand. One answer for every way
   * an id can fail, because which way would say what exists.
   */
  private async assertPublicImages(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
    what: string,
    purposes?: readonly FilePurpose[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.files.publicImagesIn(tx, orgId, ids, purposes);
    if (ids.some((id) => !found.has(id))) {
      throw new StorefrontError(
        'STOREFRONT_NOT_FOUND',
        HttpStatus.NOT_FOUND,
        `That ${what} must be a finished public image upload of this brand.`,
      );
    }
  }
}

/**
 * A timestamp as ISO text. `tx.execute` hands `timestamptz` back as the driver's text, not a
 * `Date`, so both are accepted and normalised here.
 */
function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * What the audit row keeps of a settings save: what a shopper is charged, how the checkout
 * takes money and where the website sells from. Named so that no key matches a redaction
 * pattern (`shipping` contains `pin`, `locationIds` contains `nid`).
 */
function auditSummary(settings: StorefrontSettings): Record<string, unknown> {
  const zones = settings.shipping.zones;
  return {
    freeDeliveryOn: settings.shipping.freeShippingEnabled,
    freeDeliveryFromPoisha: settings.shipping.freeShippingThresholdPoisha,
    feesPoisha: {
      inside_dhaka: zones.inside_dhaka.feePoisha,
      suburbs: zones.suburbs.feePoisha,
      outside_dhaka: zones.outside_dhaka.feePoisha,
    },
    coveredZones: {
      inside_dhaka: zones.inside_dhaka.deliveryZoneIds,
      suburbs: zones.suburbs.deliveryZoneIds,
      outside_dhaka: zones.outside_dhaka.deliveryZoneIds,
    },
    payments: settings.payments,
    sellsFrom: settings.webLocationIds,
    // Where the emails' and the payment gateway's links point (D-582).
    siteUrl: settings.siteInfo.siteUrl,
    announcementOn: settings.announcement.enabled,
    promoOn: settings.promoBanner.enabled,
  };
}

/**
 * A Site URL as `setSiteUrl` stores it (D-582): an `https://` address, the form's own rule
 * (`siteInfoSchema`, which every read parses the stored details with), with no query or
 * fragment, because the email, password-reset and payment links are built by appending paths
 * to it. Trailing slashes are dropped. Anything else is refused.
 */
export function normaliseSiteUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '');
  if (value === '' || !siteInfoSchema.shape.siteUrl.safeParse(value).success) {
    throw storefrontInvalid('The Site URL is an https:// address, like https://shop.example.com.');
  }
  const url = new URL(value);
  if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) {
    throw storefrontInvalid('The Site URL is the website’s address alone, with no ? or #.');
  }
  return value;
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function assertChart(input: SizeChartInput): void {
  const problems = sizeChartProblems(input);
  if (problems.length > 0) throw storefrontInvalid(problems[0] ?? 'That size chart is not valid.');
}

export function heroView(row: repo.HeroSlideRow) {
  return {
    id: row.id,
    desktopFileId: row.desktop_file_id,
    mobileFileId: row.mobile_file_id,
    link: row.link,
    altText: row.alt_text,
    position: row.position,
    isActive: row.is_active,
  };
}

export function navView(row: repo.NavItemRow) {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    label: row.label,
    href: row.href,
    categoryId: row.category_id,
    highlighted: row.highlighted,
    isActive: row.is_active,
    position: row.position,
  };
}

export function toDomainNav(row: repo.NavItemRow): DomainNavItem {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    label: row.label,
    href: row.href,
    categoryId: row.category_id,
    highlighted: row.highlighted,
    isActive: row.is_active,
    position: row.position,
  };
}

export function chartView(row: repo.SizeChartRow) {
  return {
    id: row.id,
    name: row.name,
    columns: row.columns,
    rows: Array.isArray(row.rows) ? row.rows : [],
    updatedAt: iso(row.updated_at),
  };
}

function keyView(row: repo.SiteKeyRow) {
  return {
    id: row.id,
    label: row.label,
    keyId: row.key_id,
    lastUsedAt: row.last_used_at === null ? null : iso(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}
