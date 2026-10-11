import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { TEAM_API, TeamApiService } from './team.api.js';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';

/**
 * The people at the desks (M41): presence and desk profiles. People's names and roles come from
 * identity's interface; the orders module (and the inbox, M42) read this one through `TEAM_API`.
 */
@Module({
  imports: [IamDirectoryModule],
  controllers: [TeamController],
  providers: [AuditService, TeamService, { provide: TEAM_API, useClass: TeamApiService }],
  exports: [TEAM_API],
})
export class TeamModule {}
