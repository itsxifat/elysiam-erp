import { Module, type DynamicModule } from '@nestjs/common';
import type { Auth } from '@elysium/db';

import { HealthModule } from './modules/health/health.module.js';
import { IamModule } from './modules/iam/iam.module.js';
import type { PasswordTokenStore } from './modules/iam/iam.service.js';

/**
 * The API's root module. Every domain module from architecture §3 registers
 * here as it lands, and modules reach each other only through the exported
 * `*.api.ts` service interfaces.
 */
@Module({})
export class AppModule {
  static register(dependencies: {
    readonly auth: Auth;
    readonly tokens: PasswordTokenStore;
  }): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule, IamModule.register(dependencies)],
    };
  }
}
