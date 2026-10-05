import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import type { ShippingRule } from '@elysium/domain/storefront';

import * as repo from './storefront.repository.js';
import { StorefrontService } from './storefront.service.js';

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

  /** Record old-site ids (M36's importer). An id already recorded is left as it was. */
  recordLegacyIds(
    tx: Tx,
    orgId: string,
    rows: readonly { readonly kind: string; readonly legacyId: string; readonly erpId: string }[],
  ): Promise<number>;
}

export const STOREFRONT_API = Symbol('StorefrontApi');

@Injectable()
export class StorefrontApiService implements StorefrontApi {
  constructor(private readonly storefront: StorefrontService) {}

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

  async recordLegacyIds(
    tx: Tx,
    orgId: string,
    rows: readonly { readonly kind: string; readonly legacyId: string; readonly erpId: string }[],
  ): Promise<number> {
    return repo.insertLegacyIds(tx, orgId, rows);
  }
}
