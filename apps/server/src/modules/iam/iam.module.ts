import { Module, type DynamicModule } from '@nestjs/common';
import type { Auth } from '@elysium/db';

import { AuditService } from '../../platform/audit/audit.service.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { IamController } from './iam.controller.js';
import { AUTH, IamService, PASSWORD_TOKENS, PasswordTokenStore } from './iam.service.js';
import { OWNER_LINK_CONFIG, ownerLinkConfig } from './owner-link.config.js';
import { OwnerLinkController } from './owner-link.controller.js';
import { OwnerLinkService } from './owner-link.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { PackingModule } from '../packing/packing.module.js';
import {
  ScannerAppSignInController,
  ScannerSignInController,
  ScannerSignInService,
} from './scanner-sign-in.js';

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
 *
 * The owner sign-in link (M31, D-473) lives here too: it ends in a Better Auth session, and
 * this is the module holding the auth instance. Its config is read at `app.init()`, so a
 * public key that cannot be read stops the process at boot.
 */
@Module({})
export class IamModule {
  static register(dependencies: {
    readonly auth: Auth;
    readonly tokens: PasswordTokenStore;
  }): DynamicModule {
    return {
      module: IamModule,
      // M35b: the packing module issues the scanner device the sign-in checks for (D-554).
      imports: [ApprovalsModule, PackingModule],
      controllers: [
        IamController,
        UsersController,
        OwnerLinkController,
        ScannerSignInController,
        ScannerAppSignInController,
      ],
      providers: [
        IamService,
        UsersService,
        AuditService,
        OwnerLinkService,
        ScannerSignInService,
        { provide: OWNER_LINK_CONFIG, useFactory: () => ownerLinkConfig() },
        { provide: AUTH, useValue: dependencies.auth },
        { provide: PASSWORD_TOKENS, useValue: dependencies.tokens },
      ],
      exports: [IamService],
    };
  }
}
