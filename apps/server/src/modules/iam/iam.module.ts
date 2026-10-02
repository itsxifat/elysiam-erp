import { Module, type DynamicModule } from '@nestjs/common';
import type { Auth } from '@elysium/db';

import { AuditService } from '../../platform/audit/audit.service.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { IamController } from './iam.controller.js';
import { AUTH, IamService, PASSWORD_TOKENS, PasswordTokenStore } from './iam.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/**
 * Identity (architecture §6). Exports the service so later modules can resolve
 * a request context without reaching into this module's tables (invariant 12).
 *
 * A dynamic module because the Better Auth instance is built in the composition
 * root — it owns a connection pool and has to be closed on shutdown, so Nest
 * receives it rather than constructing it.
 *
 * `ApprovalsModule` for the `credential_reset` executor and rejection handler: a
 * privileged person's sign-in reset waits for a second admin (gaps-users-auth, D-404).
 */
@Module({})
export class IamModule {
  static register(dependencies: {
    readonly auth: Auth;
    readonly tokens: PasswordTokenStore;
  }): DynamicModule {
    return {
      module: IamModule,
      imports: [ApprovalsModule],
      controllers: [IamController, UsersController],
      providers: [
        IamService,
        UsersService,
        AuditService,
        { provide: AUTH, useValue: dependencies.auth },
        { provide: PASSWORD_TOKENS, useValue: dependencies.tokens },
      ],
      exports: [IamService],
    };
  }
}
