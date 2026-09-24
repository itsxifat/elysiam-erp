import { Module, type DynamicModule } from '@nestjs/common';
import type { Auth } from '@elysium/db';

import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { DemoModule } from './modules/demo/demo.module.js';
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
    /**
     * Mount the demo resource. Defaults to off in production and on elsewhere.
     *
     * `demo.costed_items` exists so the matrix suite has something real to run
     * against — the same RLS, the same guard, the same serializer as everything
     * that comes after, rather than a mock that proves the mock. That makes it
     * worth having and does not make it worth deploying: it is a writable
     * endpoint with no business behind it, and M06 replaces it with the real
     * catalog.
     *
     * A flag rather than a `NODE_ENV` check inside the module, because the
     * route-coverage gate and the boot test both need to see these routes, and
     * a module that decides for itself is one the gate cannot ask.
     */
    readonly demo?: boolean;
  }): DynamicModule {
    const withDemo = dependencies.demo ?? process.env.NODE_ENV !== 'production';

    return {
      module: AppModule,
      imports: [
        HealthModule,
        IamModule.register(dependencies),
        ApprovalsModule,
        ...(withDemo ? [DemoModule] : []),
      ],
    };
  }
}
