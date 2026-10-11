import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { TeamReferencesBinding } from './references.binding.js';
import { TEAM_API, TeamApiService } from './team.api.js';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';

/**
 * The people at the desks (M41): presence and desk profiles. People's names and roles come from
 * identity's interface; the orders module (and the inbox, M42) read this one through `TEAM_API`.
 */
@Module({
  imports: [IamDirectoryModule, InventoryModule],
  controllers: [TeamController],
  providers: [
    AuditService,
    TeamService,
    { provide: TEAM_API, useClass: TeamApiService },
    // M41: a hub location named on a desk profile is in use (D-621).
    TeamReferencesBinding,
  ],
  exports: [TEAM_API],
})
export class TeamModule {}
