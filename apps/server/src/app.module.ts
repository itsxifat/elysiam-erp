import { Module } from '@nestjs/common';

import { HealthModule } from './modules/health/health.module.js';
import { IamModule } from './modules/iam/iam.module.js';

/**
 * The API's root module. Every domain module from architecture §3 registers
 * here as it lands, and modules reach each other only through the exported
 * `*.api.ts` service interfaces.
 */
@Module({ imports: [HealthModule, IamModule] })
export class AppModule {}
