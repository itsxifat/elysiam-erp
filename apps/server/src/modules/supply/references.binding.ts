import { Injectable, type OnModuleInit } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogReferences } from '../catalog/ports/catalog-references.port.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';
import * as refs from './references.repository.js';

/**
 * Supply's answers to "what uses this row?" (M39a, D-621, D-629): a supply or return line
 * keeps its SKU; a supply entry or return keeps its location.
 *
 * A standard buying price (M39b, D-638) keeps nothing: it is a setting for the next receipt.
 * When a variant nobody used is deleted, `release` removes its standard prices and writes one
 * audit row with how many (never the figures, invariant 5), so the delete leaves a trace.
 */
@Injectable()
export class SupplyReferencesBinding implements OnModuleInit {
  constructor(
    private readonly catalog: CatalogReferences,
    private readonly locations: LocationReferences,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.catalog.register({
      module: 'supply',
      references: async (tx, orgId, kind, ids) =>
        kind === 'sku'
          ? [{ reason: 'supply_lines', count: await refs.supplyLinesForSkus(tx, orgId, ids) }]
          : [],
      release: async (tx, orgId, kind, ids) => {
        if (kind !== 'sku') return;
        const removed = await refs.releaseStandardPrices(tx, orgId, ids);
        if (removed === 0) return;
        const actor = await refs.sessionActor(tx);
        await this.audit.record(tx, {
          orgId,
          actorUserId: actor.userId,
          operation: 'delete',
          action: 'supply.standard_costs.removed',
          entityType: 'SkuPurchasePrice',
          entityId: ids.length === 1 ? (ids[0] ?? orgId) : orgId,
          before: { standardBuyingPrices: removed, variants: ids.length },
          after: null,
          requestId: actor.requestId,
        });
      },
    });
    this.locations.register({
      module: 'supply',
      references: async (tx, orgId, _kind, ids) => [
        {
          reason: 'supply_entries',
          count: await refs.supplyEntriesAtLocation(tx, orgId, ids[0] ?? ''),
        },
      ],
    });
  }
}
