import { Module } from '@nestjs/common';

import { IamController } from './iam.controller.js';
import { IamService } from './iam.service.js';

/**
 * Identity (architecture §6). Exports the service so later modules can resolve
 * a request context without reaching into this module's tables (invariant 12).
 */
@Module({
  controllers: [IamController],
  providers: [IamService],
  exports: [IamService],
})
export class IamModule {}
