import { Injectable } from '@nestjs/common';

import {
  ReferenceRegistry,
  type ReferenceChecker,
} from '../../../platform/references/references.js';

/**
 * Which modules use a stock location, asked before it is deleted (M39a, D-629).
 *
 * Locations are `org.locations`, set up through this module (D-046). Orders, the till,
 * supply, couriers and the website all name them and all import this module, so they
 * register here when they start and count their own rows; inventory counts its movements,
 * levels and documents itself. The same shape as the catalog's `CatalogReferences` (D-621).
 */
export type LocationRefKind = 'location';

export type LocationReferenceChecker = ReferenceChecker<LocationRefKind>;

@Injectable()
export class LocationReferences extends ReferenceRegistry<LocationRefKind> {
  constructor() {
    super('location');
  }
}
