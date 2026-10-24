import { Injectable, type OnModuleInit } from '@nestjs/common';

import { LocationReferences } from '../inventory/ports/location-references.port.js';
import { terminalsAt } from './labels.repository.js';

/**
 * Packing's answer to "what uses this stock location?" (M46, D-621's pattern): a label or packing
 * terminal stands at a hub's location, and its print log and packing record name it. Inventory
 * cannot read `packing.*` (invariant 12), so this module hands itself in to inventory's registry
 * when it starts. Not movable: the terminal is moved, or switched off and kept, on Labels →
 * Terminals first. Without it a location a terminal stands at failed its delete on the foreign key.
 */
@Injectable()
export class PackingLocationReferences implements OnModuleInit {
  constructor(private readonly locations: LocationReferences) {}

  onModuleInit(): void {
    this.locations.register({
      module: 'packing',
      references: async (tx, orgId, _kind, ids) => [
        { reason: 'packing_terminals', count: await terminalsAt(tx, orgId, ids[0] ?? '') },
      ],
    });
  }
}
