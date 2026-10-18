import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { FilesModule } from '../files/files.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { OrdersModule } from '../orders/orders.module.js';
import { TelephonyCallsService } from './calls.service.js';
import { TelephonyConnectionsService } from './connections.service.js';
import { TelephonyIngestService } from './ingest.service.js';
import { EnvoWebhookRawBody } from './raw-body.js';
import { TelephonyRecordingsService } from './recordings.service.js';
import { TelephonySyncService } from './sync.service.js';
import {
  TELEPHONY_CONFIG,
  envoGatewayFor,
  telephonyConfig,
  type TelephonyConfig,
} from './telephony.config.js';
import { TelephonyController } from './telephony.controller.js';
import { ENVO_GATEWAY } from './telephony.tokens.js';
import { EnvoWebhookController } from './webhook.controller.js';
import { TelephonyWebhookService } from './webhook.service.js';

/**
 * Phone calls through Envo (M47, D-830 to D-853): Settings → Calls, the extensions, calling a
 * customer from one's own extension, the web phone's token, Envo's signed webhooks, the call log
 * with its recordings, the sync and the retention.
 *
 * Buyers and orders through `ORDERS_API` (with M41's owner gate), people through `IAM_API`,
 * recordings through `FILES_API` (invariant 12). The config and the adapter are factories run at
 * `app.init()`, so a half-set configuration stops the process at boot.
 */
const configProvider: Provider = {
  provide: TELEPHONY_CONFIG,
  useFactory: () => telephonyConfig(),
};

const gatewayProvider: Provider = {
  provide: ENVO_GATEWAY,
  useFactory: (config: TelephonyConfig) => envoGatewayFor(config),
  inject: [TELEPHONY_CONFIG],
};

@Module({
  imports: [OrdersModule, IamDirectoryModule, FilesModule],
  controllers: [TelephonyController, EnvoWebhookController],
  providers: [
    configProvider,
    gatewayProvider,
    AuditService,
    EnvoWebhookRawBody,
    TelephonyIngestService,
    TelephonyConnectionsService,
    TelephonyCallsService,
    TelephonyWebhookService,
    TelephonySyncService,
    TelephonyRecordingsService,
  ],
  exports: [
    TelephonyWebhookService,
    TelephonySyncService,
    TelephonyRecordingsService,
    ENVO_GATEWAY,
  ],
})
export class TelephonyModule {}
