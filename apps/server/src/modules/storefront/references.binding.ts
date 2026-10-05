import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import { AuditService } from '../../platform/audit/audit.service.js';
import {
  CatalogReferences,
  type CatalogRefKind,
  type MoveActor,
} from '../catalog/ports/catalog-references.port.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';
import { DiscountReferences } from '../promo/ports/discount-references.port.js';
import * as refs from './references.repository.js';
import { SiteCache } from './site-cache.js';

/** The old site's id kind for each ERP row kind a delete releases (D-505). */
const LEGACY_KIND: Readonly<Partial<Record<string, string>>> = {
  category: 'category',
  product: 'product',
  sku: 'variant',
  discount: 'discount',
  flash_sale: 'flash_sale',
};

/**
 * The website's answers to "what uses this row?" (M39a, D-621, D-628, D-629, D-631).
 *
 * - A menu entry keeps its category (the foreign key is `restrict`), but it can be moved:
 *   "Empty and delete" points it at the category the products went to, or removes it when
 *   they went nowhere (`moveCategory`), with an audit row holding each removed entry.
 * - The old site's ids for a deleted row are forgotten (`release`): nothing at the old
 *   address exists any more, and a redirect to a deleted row would be a 404 anyway.
 * - A location the website sells from keeps that location: the brand changes Website →
 *   Settings first, deliberately.
 * - A campaign link (M35b, D-551; joined at integration) keeps the category it opens and the
 *   products it highlights. It is never re-pointed or trimmed by a delete: the link is already
 *   shared in ads and posts, so the person edits or deletes it in Website → Campaign links
 *   first, or archives the category or product instead. Not movable, so "Empty and delete"
 *   refuses as well.
 */
@Injectable()
export class StorefrontReferencesBinding implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    private readonly locations: LocationReferences,
    private readonly discounts: DiscountReferences,
    private readonly cache: SiteCache,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'storefront',
      references: async (tx, orgId, kind, ids) => {
        if (kind === 'category') {
          return [
            {
              reason: 'menu_entries',
              ...(await refs.menuEntriesFor(tx, orgId, ids)),
              movable: true,
            },
            {
              reason: 'campaign_links',
              ...(await refs.campaignLinksForCategories(tx, orgId, ids)),
            },
          ];
        }
        if (kind === 'product') {
          return [
            { reason: 'campaign_links', ...(await refs.campaignLinksForProducts(tx, orgId, ids)) },
          ];
        }
        return [];
      },
      release: (tx, orgId, kind, ids) => this.forget(tx, orgId, kind, ids),
      moveCategory: (tx, orgId, fromId, toId, actor) =>
        this.moveCategory(tx, orgId, fromId, toId, actor),
    });
    this.locations.register({
      module: 'storefront',
      references: async (tx, orgId, _kind, ids) => [
        { reason: 'web_locations', count: await refs.webLocationUses(tx, orgId, ids[0] ?? '') },
      ],
    });
    this.discounts.register({
      module: 'storefront',
      references: () => Promise.resolve([]),
      release: (tx, orgId, kind, ids) => this.forget(tx, orgId, kind, ids),
    });
  }

  private async forget(
    tx: Tx,
    orgId: string,
    kind: CatalogRefKind | 'discount' | 'flash_sale',
    ids: readonly string[],
  ): Promise<void> {
    const legacyKind = LEGACY_KIND[kind];
    if (legacyKind !== undefined) await refs.forgetLegacyIds(tx, orgId, legacyKind, ids);
  }

  private async moveCategory(
    tx: Tx,
    orgId: string,
    fromId: string,
    toId: string | null,
    actor: MoveActor,
  ): Promise<number> {
    let moved: number;
    if (toId !== null) {
      moved = await refs.repointMenuEntries(tx, orgId, fromId, toId);
    } else {
      const removed = await refs.removeMenuEntries(tx, orgId, fromId);
      for (const entry of removed) {
        await this.audit.record(tx, {
          orgId,
          actorUserId: actor.userId,
          operation: 'delete',
          action: 'storefront.nav_item.deleted',
          entityType: 'NavItem',
          entityId: entry.id,
          before: { ...entry, because: 'its category was emptied and deleted' },
          after: null,
          requestId: actor.requestId,
        });
      }
      moved = removed.length;
    }
    // The menu is read through the site cache; the next read takes the new one.
    if (moved > 0) this.cache.forget(orgId);
    return moved;
  }
}
