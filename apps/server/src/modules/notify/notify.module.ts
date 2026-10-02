import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { NOTIFY_API, NotifyApiService } from './notify.api.js';
import { gatewayFor, NOTIFY_CONFIG, notifyConfig, type NotifyConfig } from './notify.config.js';
import { NotifyController } from './notify.controller.js';
import { NotifyService } from './notify.service.js';
import { SMS_GATEWAY } from './providers/sms-gateway.js';

/**
 * Notifications (architecture §10; M16).
 *
 * The config and the gateway are factories, so they run at `app.init()`: naming the
 * unverified BulkSMSBD gateway without also opting into it stops the process at boot
 * instead of silently sending through the fake (D-012, D-205). A deployment that thinks it
 * is texting its buyers and is not is the failure worth preventing.
 */
const configProvider: Provider = { provide: NOTIFY_CONFIG, useFactory: () => notifyConfig() };

const gatewayProvider: Provider = {
  provide: SMS_GATEWAY,
  useFactory: (config: NotifyConfig) => gatewayFor(config),
  inject: [NOTIFY_CONFIG],
};

@Module({
  controllers: [NotifyController],
  providers: [
    configProvider,
    gatewayProvider,
    // Provided rather than imported, as every other module does it.
    AuditService,
    NotifyService,
    { provide: NOTIFY_API, useClass: NotifyApiService },
  ],
  exports: [NOTIFY_API, NotifyService, SMS_GATEWAY],
})
export class NotifyModule {}
