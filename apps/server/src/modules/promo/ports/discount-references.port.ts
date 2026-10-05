import { Injectable } from '@nestjs/common';

import {
  ReferenceRegistry,
  type ReferenceChecker,
} from '../../../platform/references/references.js';

/**
 * Which modules use a discount or a flash sale, asked before it is deleted (M39a, D-631).
 *
 * Orders name a discount (`sales.orders.promo_code_id`, the CRM's occasion codes) and the
 * website keeps the old site's ids for both; those modules import this one, so they register
 * here when they start and count their own rows. Promotions counts its redemptions and
 * claims itself. The same shape as the catalog's `CatalogReferences` (D-621).
 */
export type PromoRefKind = 'discount' | 'flash_sale';

export type PromoReferenceChecker = ReferenceChecker<PromoRefKind>;

@Injectable()
export class DiscountReferences extends ReferenceRegistry<PromoRefKind> {
  constructor() {
    super('promo');
  }
}
