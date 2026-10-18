import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import type { ShippingRule } from '@elysium/domain/storefront';

import { FilesService } from '../files/files.service.js';
import * as buying from './buying.repository.js';
import { StorefrontPublicService } from './storefront-public.service.js';
import * as repo from './storefront.repository.js';
import { StorefrontService } from './storefront.service.js';
import { TrackingService, type PurchaseFacts } from './tracking.service.js';

export type { PurchaseFacts };

/**
 * What other modules may ask the website module (invariant 12; M33, D-503, D-505).
 *
 * M34's checkout holds stock at the web locations and charges the shipping rule; M35's
 * marketplace connector and M36's importer read and write the old site's ids. Each is a
 * question answered here, inside the caller's transaction, rather than a read of the
 * `storefront` schema from somebody else's repository.
 */
export interface StorefrontApi {
  /** Where the website sells from: the brand's chosen locations, or its main warehouse. */
  webLocationIds(tx: Tx, orgId: string): Promise<readonly string[]>;

  /** The website's shipping rule, money as poisha (`shippingFeeFor` prices it). */
  shippingRule(tx: Tx, orgId: string): Promise<ShippingRule>;

  /** What these old-site ids of one kind became here. An unknown id is absent. */
  legacyIds(
    tx: Tx,
    orgId: string,
    kind: string,
    legacyIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  /**
   * The old-site id each of these ERP rows carries, if any (M35b: the marketplace connector
   * answers ncom with the ids its saved offers already hold, D-553).
   */
  legacyIdsFor(
    tx: Tx,
    orgId: string,
    kind: string,
    erpIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  /** Record old-site ids (M36's importer). An id already recorded is left as it was. */
  recordLegacyIds(
    tx: Tx,
    orgId: string,
    rows: readonly { readonly kind: string; readonly legacyId: string; readonly erpId: string }[],
  ): Promise<number>;

  /**
   * The website's own name and address and the courier merchant id the brand prints on its
   * labels (M35b: the order labels, D-555, and the marketplace connector's product links).
   */
  siteFacts(
    tx: Tx,
    orgId: string,
  ): Promise<{
    readonly siteName: string;
    /** Without a trailing slash; empty when the brand has not set one. */
    readonly siteUrl: string;
    readonly merchantId: string;
  }>;

  /**
   * The public addresses of these stored images, the full size (M35b: the marketplace
   * connector's product pictures, which ncom's pages load straight from the brand, D-553).
   * Only public website images; anything else is absent.
   */
  publicImageUrls(
    tx: Tx,
    orgId: string,
    fileIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;

  /**
   * The server-side `Purchase` for an order another module placed (M35b, D-552: the
   * marketplace's), logged and queued in the caller's transaction.
   */
  recordPurchase(tx: Tx, orgId: string, facts: PurchaseFacts): Promise<void>;

  /**
   * One size chart as the brand typed it (M44b, D-771): the inbox turns a customer's measurement
   * into a size through the chart of the product being sold. Absent when the brand has none.
   */
  sizeChart(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<
    | {
        readonly id: string;
        readonly name: string;
        readonly columns: readonly string[];
        readonly rows: readonly (readonly string[])[];
      }
    | undefined
  >;

  /**
   * The website accounts linked to this buyer, newest first, as their email and whether it was
   * verified (M47, D-860: the caller panel's emails). No password, no Google id, no addresses.
   */
  accountsOfCustomer(
    tx: Tx,
    orgId: string,
    customerId: string,
  ): Promise<readonly { readonly email: string; readonly verified: boolean }[]>;
}

export const STOREFRONT_API = Symbol('StorefrontApi');

@Injectable()
export class StorefrontApiService implements StorefrontApi {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly tracking: TrackingService,
    private readonly files: FilesService,
    private readonly publicService: StorefrontPublicService,
  ) {}

  async siteFacts(tx: Tx, orgId: string) {
    const settings = await this.storefront.settingsIn(tx, orgId);
    return {
      siteName: settings.siteInfo.siteName,
      siteUrl: settings.siteInfo.siteUrl.replace(/\/+$/, ''),
      merchantId: settings.siteInfo.merchantId,
    };
  }

  async publicImageUrls(
    tx: Tx,
    orgId: string,
    fileIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (fileIds.length === 0) return new Map();
    const media = await this.files.publicImagesIn(tx, orgId, [...new Set(fileIds)]);
    const out = new Map<string, string>();
    for (const fileId of fileIds) {
      const image = this.publicService.image(orgId, fileId, null, media);
      if (image !== null) out.set(fileId, image.urls.full);
    }
    return out;
  }

  async recordPurchase(tx: Tx, orgId: string, facts: PurchaseFacts): Promise<void> {
    await this.tracking.recordPurchase(tx, orgId, facts);
  }

  async webLocationIds(tx: Tx, orgId: string): Promise<readonly string[]> {
    return (await this.storefront.settingsIn(tx, orgId)).webLocationIds;
  }

  async shippingRule(tx: Tx, orgId: string): Promise<ShippingRule> {
    const { shipping } = await this.storefront.settingsIn(tx, orgId);
    const zone = (key: 'inside_dhaka' | 'suburbs' | 'outside_dhaka') => ({
      feePoisha: poisha(shipping.zones[key].feePoisha),
      deliveryZoneIds: shipping.zones[key].deliveryZoneIds,
    });
    return {
      freeShippingEnabled: shipping.freeShippingEnabled,
      freeShippingThresholdPoisha:
        shipping.freeShippingThresholdPoisha === null
          ? null
          : poisha(shipping.freeShippingThresholdPoisha),
      zones: {
        inside_dhaka: zone('inside_dhaka'),
        suburbs: zone('suburbs'),
        outside_dhaka: zone('outside_dhaka'),
      },
    };
  }

  async legacyIds(
    tx: Tx,
    orgId: string,
    kind: string,
    legacyIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return repo.legacyIds(tx, orgId, kind, [...new Set(legacyIds)]);
  }

  async legacyIdsFor(
    tx: Tx,
    orgId: string,
    kind: string,
    erpIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return repo.legacyIdsFor(tx, orgId, kind, [...new Set(erpIds)]);
  }

  async recordLegacyIds(
    tx: Tx,
    orgId: string,
    rows: readonly { readonly kind: string; readonly legacyId: string; readonly erpId: string }[],
  ): Promise<number> {
    return repo.insertLegacyIds(tx, orgId, rows);
  }

  async sizeChart(tx: Tx, orgId: string, id: string) {
    const row = await repo.sizeChartById(tx, orgId, id);
    return row === undefined
      ? undefined
      : { id: row.id, name: row.name, columns: row.columns, rows: row.rows };
  }

  async accountsOfCustomer(tx: Tx, orgId: string, customerId: string) {
    const { rows } = await buying.listAccounts(tx, orgId, { customerId, limit: 10, offset: 0 });
    return rows.map((row) => ({ email: row.email, verified: row.email_verified_at !== null }));
  }
}
