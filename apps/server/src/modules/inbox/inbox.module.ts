import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { OrdersModule } from '../orders/orders.module.js';
import { StorefrontModule } from '../storefront/storefront.module.js';
import { TeamModule } from '../team/team.module.js';
import { InboxCatalogReferences } from './catalog-references.binding.js';
import { InboxChannelsService } from './channels.service.js';
import { ConversationOffersService } from './conversation-offers.service.js';
import { ConversationsService } from './conversations.service.js';
import {
  INBOX_CONFIG,
  inboxConfig,
  messagingGatewayFor,
  type InboxConfig,
} from './inbox.config.js';
import { InboxController } from './inbox.controller.js';
import { InboxOrderListener } from './order-listener.service.js';
import { ContactPanelService } from './panel.service.js';
import { CONVERSATION_OFFER } from './ports/conversation-offer.port.js';
import { MESSAGING_GATEWAY } from './providers/meta-messaging.js';
import { MetaWebhookRawBody } from './raw-body.js';
import { InboxSellingController } from './selling.controller.js';
import { InboxSellingService } from './selling.service.js';
import { InboxSendService } from './send.service.js';
import { MetaWebhookController } from './webhook.controller.js';
import { InboxWebhookService } from './webhook.service.js';

/**
 * The unified inbox (M42, D-730 to D-749): Messenger, Instagram and WhatsApp conversations, the
 * customer panel, replies sent by a job, and Settings → Inbox.
 *
 * Buyers and orders through `ORDERS_API`, products through `CATALOG_API`, people through
 * `IAM_API` (invariant 12). The config and the gateway are factories run at `app.init()`: naming
 * the unverified Graph adapter without opting in stops the process at boot (D-731). Auto-offer
 * is M41's engine bound to the port: `ConversationOffersService`, with people and presence
 * through `TEAM_API` and the brand's switch through `ORDERS_API` (D-737, D-748).
 */
const configProvider: Provider = {
  provide: INBOX_CONFIG,
  useFactory: () => inboxConfig(),
};

const gatewayProvider: Provider = {
  provide: MESSAGING_GATEWAY,
  useFactory: (config: InboxConfig) => messagingGatewayFor(config),
  inject: [INBOX_CONFIG],
};

@Module({
  // M44b: size charts and the website's address through STOREFRONT_API (D-771, D-772).
  imports: [OrdersModule, CatalogModule, IamDirectoryModule, TeamModule, StorefrontModule],
  controllers: [InboxController, MetaWebhookController, InboxSellingController],
  providers: [
    configProvider,
    gatewayProvider,
    AuditService,
    MetaWebhookRawBody,
    ConversationOffersService,
    { provide: CONVERSATION_OFFER, useExisting: ConversationOffersService },
    ConversationsService,
    ContactPanelService,
    InboxChannelsService,
    InboxWebhookService,
    InboxSendService,
    InboxOrderListener,
    InboxSellingService,
    // D-621: a customer's interest keeps the product it names.
    InboxCatalogReferences,
  ],
  exports: [
    InboxWebhookService,
    InboxSendService,
    InboxOrderListener,
    ConversationOffersService,
    MESSAGING_GATEWAY,
  ],
})
export class InboxModule {}
