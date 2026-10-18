import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { CallerPanelService } from './caller-panel.service.js';
import { TelephonyCallsService } from './calls.service.js';
import { TelephonyConnectionsService } from './connections.service.js';
import { TelephonyIngestService } from './ingest.service.js';
import { EnvoWebhookRawBody } from './raw-body.js';
import { TelephonySyncService } from './sync.service.js';
import {
  TELEPHONY_CONFIG,
  envoGatewayFor,
  telephonyConfig,
  type TelephonyConfig,
} from './telephony.config.js';
import { CustomerPinnedNoteController, TelephonyController } from './telephony.controller.js';
import { ENVO_GATEWAY } from './telephony.tokens.js';
import { EnvoWebhookController } from './webhook.controller.js';
import { TelephonyWebhookService } from './webhook.service.js';

/**
 * Phone calls through Envo (M47, D-830 to D-853): Settings → Calls, the extensions, calling a
 * customer from one's own extension, the web phone's token, Envo's signed webhooks, the call log
 * with its recordings streamed from Envo (D-858), the sync and the webhook bodies' retention.
 *
 * Buyers and orders through `ORDERS_API` (with M41's owner gate), people through `IAM_API`,
 * the inbox through `INBOX_API`, website accounts through `STOREFRONT_API` (invariant 12). The
 * config and the adapter are factories run at `app.init()`, so a half-set configuration stops
 * the process at boot.
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
  // M47 (D-860, D-862): INBOX_API and STOREFRONT_API for the caller panel and an inbox Call.
  imports: [OrdersModule, IamDirectoryModule, InboxModule, StorefrontModule],
  controllers: [TelephonyController, CustomerPinnedNoteController, EnvoWebhookController],
  providers: [
    configProvider,
    gatewayProvider,
    AuditService,
    EnvoWebhookRawBody,
    TelephonyIngestService,
    TelephonyConnectionsService,
    TelephonyCallsService,
    // M47 (D-860): the caller panel.
    CallerPanelService,
    TelephonyWebhookService,
    TelephonySyncService,
  ],
  exports: [TelephonyWebhookService, TelephonySyncService, ENVO_GATEWAY],
})
export class TelephonyModule {}
