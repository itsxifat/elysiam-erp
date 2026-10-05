import type {
  CampaignLinkInput,
  MarketplaceSettingsInput,
  TrackingSettingsInput,
} from '@elysium/contracts';

import { api } from '../../api.js';

/**
 * Website → Campaign links, Tracking and Marketplace (M35b, D-551 to D-553), typed to what the
 * server returns. Bodies are the shared contract types. Secrets go one way: a save may carry a
 * token, an answer carries only its fingerprint.
 */

export interface CampaignBanner {
  readonly enabled: boolean;
  readonly text: string;
  readonly bgColor: string;
  readonly textColor: string;
  readonly link: string;
}

export interface CampaignModal {
  readonly enabled: boolean;
  readonly type: 'text' | 'image';
  readonly title: string;
  readonly text: string;
  readonly imageFileId: string | null;
  readonly ctaText: string;
  readonly ctaLink: string;
}

export interface CampaignLink {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly baseType: 'category' | 'shop' | 'custom';
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly customPath: string;
  readonly highlightProductIds: readonly string[];
  readonly banner: CampaignBanner;
  readonly modal: CampaignModal;
  readonly isActive: boolean;
  readonly views: number;
  /** `/shop?category=panjabi&cu=48213`. */
  readonly path: string;
  /** The full address on the brand's site, once the site's address is set. */
  readonly url: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function listCampaignLinks(): Promise<{
  items: readonly CampaignLink[];
  siteUrl: string | null;
}> {
  return api.get('/v1/storefront/campaign-links');
}
export function createCampaignLink(
  input: CampaignLinkInput,
): Promise<{ id: string; code: string }> {
  return api.post('/v1/storefront/campaign-links', input);
}
export function updateCampaignLink(id: string, input: CampaignLinkInput): Promise<{ id: string }> {
  return api.put(`/v1/storefront/campaign-links/${id}`, input);
}
export function deleteCampaignLink(id: string): Promise<{ id: string }> {
  return api.delete(`/v1/storefront/campaign-links/${id}`);
}

export interface TrackingRoute {
  readonly name: string;
  readonly enabled: boolean;
  readonly client: boolean;
  readonly server: boolean;
  readonly meta: boolean;
  readonly ga4: boolean;
}

export interface TrackingSettingsView {
  readonly settings: {
    readonly meta: {
      readonly pixelEnabled: boolean;
      readonly capiEnabled: boolean;
      readonly pixelId: string;
      readonly datasetId: string;
      readonly apiVersion: string;
      readonly accessTokenSet: boolean;
      readonly accessTokenFingerprint: string | null;
      readonly testEventCode: string;
      readonly defaultCountryCode: string;
    };
    readonly ga4: {
      readonly clientEnabled: boolean;
      readonly mpEnabled: boolean;
      readonly measurementId: string;
      readonly apiSecretSet: boolean;
      readonly apiSecretFingerprint: string | null;
    };
    readonly proxy: {
      readonly metaScriptPath: string;
      readonly metaCollectPath: string;
      readonly ga4ScriptPath: string;
      readonly ga4CollectPath: string;
    };
    readonly testMode: boolean;
    readonly events: readonly TrackingRoute[];
    readonly logRetentionDays: number;
    readonly updatedAt: string | null;
  };
  /** `fake` records sends without making them; `live` calls Meta and Google. */
  readonly provider: 'fake' | 'live';
  readonly credentialsKey: boolean;
}

export type TrackingStatus = 'waiting' | 'queued' | 'success' | 'partial' | 'error' | 'skipped';

export interface TrackingEventRow {
  readonly id: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly source: 'client' | 'server';
  readonly testMode: boolean;
  readonly orderId: string | null;
  /** Already masked by the server: `R***@Example.com`, `+880 17** ***678`. */
  readonly user: Record<string, string> | null;
  readonly matchKeys: readonly string[] | null;
  readonly value: string | null;
  readonly currency: string | null;
  readonly status: TrackingStatus;
  readonly meta: { readonly status?: string; readonly error?: string | null } | null;
  readonly ga4: { readonly status?: string; readonly error?: string | null } | null;
  readonly attempts: number;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export function getTracking(): Promise<TrackingSettingsView> {
  return api.get('/v1/storefront/tracking');
}
export function saveTracking(input: TrackingSettingsInput): Promise<TrackingSettingsView> {
  return api.put('/v1/storefront/tracking', input);
}
export function listTrackingEvents(query: {
  readonly status?: TrackingStatus | undefined;
  readonly cursor?: string | undefined;
}): Promise<{
  items: readonly TrackingEventRow[];
  nextCursor: string | null;
  stats: readonly { status: string; count: number }[];
}> {
  const params = new URLSearchParams({ limit: '50' });
  if (query.status !== undefined) params.set('status', query.status);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return api.get(`/v1/storefront/tracking/events?${params.toString()}`);
}

export interface MarketplaceView {
  readonly settings: {
    readonly enabled: boolean;
    readonly acceptOrders: boolean;
    readonly includeDrafts: boolean;
    readonly allowSearch: boolean;
    readonly allowCategories: boolean;
    readonly allowReserve: boolean;
    readonly defaultWeightGrams: number;
    readonly publicBaseUrl: string;
    readonly baseUrl: string;
    readonly connectorKeyId: string;
    readonly orderKeyId: string;
    readonly connectorSecretFingerprint: string | null;
    readonly orderSecretFingerprint: string | null;
    readonly apiKeyFingerprint: string | null;
    readonly webhookSecretFingerprint: string | null;
  };
  readonly addresses: {
    readonly connector: string;
    readonly orders: string;
    readonly webhook: string;
  };
  readonly activity: {
    readonly lastRequestAt: string | null;
    readonly lastRequestKind: string | null;
    readonly requestCounts: Record<string, number>;
    readonly lastRefusalReason: string | null;
    readonly lastRefusalAt: string | null;
    readonly lastOrderAt: string | null;
    readonly ordersReceived: number;
    readonly lastWebhookAt: string | null;
  };
  readonly credentialsKey: boolean;
}

export interface NcomHold {
  readonly id: string;
  readonly orderRef: string;
  readonly state: 'held' | 'released' | 'converted';
  readonly locationId: string;
  readonly lines: readonly { skuId: string; variantId: string; qty: number }[];
  readonly heldAt: string | null;
  readonly releasedAt: string | null;
  readonly convertedOrderId: string | null;
}

export interface NcomOrderRow {
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly status: string | null;
  readonly codAmountPoisha: string | null;
  readonly ncomOrderId: string;
  readonly ncomOrderNumber: string | null;
  readonly storeName: string | null;
  readonly pageTitle: string | null;
  readonly offerLabel: string | null;
  readonly revision: number;
  readonly stockHeld: boolean;
  /** Lines of other shops in ncom's order: shown, never sold or collected here. */
  readonly foreignItems:
    | readonly {
        readonly title: string;
        readonly variantTitle: string;
        readonly sku: string;
        readonly quantity: number;
        readonly pricePoisha: string;
      }[]
    | null;
  readonly foreignPoisha: string;
  readonly warnings: readonly string[] | null;
  readonly receivedAt: string | null;
  readonly messages: readonly {
    readonly id: string;
    readonly topic: string;
    readonly revision: number;
    readonly status: 'pending' | 'delivered' | 'refused' | 'failed';
    readonly attempts: number;
    readonly statusCode: number | null;
    readonly error: string | null;
    readonly nextAttemptAt: string | null;
    readonly deliveredAt: string | null;
  }[];
}

export function getMarketplace(): Promise<MarketplaceView> {
  return api.get('/v1/marketplace/ncom');
}
export function saveMarketplace(input: MarketplaceSettingsInput): Promise<MarketplaceView> {
  return api.put('/v1/marketplace/ncom', input);
}
export function listHolds(): Promise<{ items: readonly NcomHold[] }> {
  return api.get('/v1/marketplace/ncom/holds');
}
export function releaseHold(id: string): Promise<{ id: string; state: string }> {
  return api.post(`/v1/marketplace/ncom/holds/${id}/release`);
}
export function listNcomOrders(): Promise<{ items: readonly NcomOrderRow[] }> {
  return api.get('/v1/marketplace/ncom/orders');
}
