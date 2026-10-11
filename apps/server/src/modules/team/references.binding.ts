import { Injectable, type OnModuleInit } from '@nestjs/common';

import { LocationReferences } from '../inventory/ports/location-references.port.js';
import * as repo from './team.repository.js';

/**
 * The team module's answer to "what uses this stock location?" (M41, D-621's pattern): a staff
 * member's desk profile names it as the hub they pack at. Inventory cannot read `team.*`
 * (invariant 12), so this module hands itself in to inventory's registry when it starts. Not
 * movable: the person's hub is changed on the Staff screen first.
 */
@Injectable()
export class TeamReferencesBinding implements OnModuleInit {
  constructor(private readonly locations: LocationReferences) {}

  onModuleInit(): void {
    this.locations.register({
      module: 'team',
      references: async (tx, orgId, _kind, ids) => [
        { reason: 'desk_profiles', count: await repo.hubProfilesAt(tx, orgId, ids[0] ?? '') },
      ],
    });
  }
}
