import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';

/**
 * Maker-checker (architecture §6). Exports the service so later modules ask
 * "does this need approval" through it rather than reading its tables
 * (invariant 12).
 */
@Module({
  // Identity's interface, for the trust count that can set aside the grant lineage (D-655).
  imports: [IamDirectoryModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, AuditService],
  exports: [ApprovalsService, AuditService],
})
export class ApprovalsModule {}
