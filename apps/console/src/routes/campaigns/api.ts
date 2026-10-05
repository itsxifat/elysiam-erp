import { api } from '../../api.js';

/**
 * `/v1/promo/*` and `/v1/notify/*`, typed to what the controllers return (M16, M35a).
 *
 * Hand-written for the reason the orders client gives. Amounts are decimal strings of
 * poisha; a discount's value is basis points (percent) or poisha (flat). Selling prices
 * only: nothing here carries a cost.
 */

/** M16's three kinds and M35a's two (D-541). */
export const PROMO_KINDS = ['percent', 'flat', 'free_delivery', 'buy_x_get_y', 'tiered'] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];

export const PROMO_METHODS = ['code', 'automatic'] as const;
export type PromoMethod = (typeof PROMO_METHODS)[number];

export const PROMO_STATUSES = ['active', 'paused', 'archived'] as const;
export type PromoStatus = (typeof PROMO_STATUSES)[number];

/**
 * The channels a code can be limited to in this console: the order channels.
 *
 * The server also accepts `pos`, but the till does not redeem codes yet (D-209), so a code
 * limited to it would never apply anywhere. Offering it would be offering a dead option.
 */
export const PROMO_FORM_CHANNELS = [
  'facebook',
  'whatsapp',
  'instagram',
  'tiktok',
  'landing_page',
  'website',
  'phone',
  'walk_in',
  'reseller',
] as const;

export interface DiscountTier {
  readonly minSubtotalPoisha: string;
  readonly kind: 'percent' | 'flat';
  readonly valueBps: number;
  readonly valuePoisha: string;
}

/** A discount as `GET /v1/promo/codes` lists it: an M16 code or an M35a discount. */
export interface PromoCode {
  readonly id: string;
  readonly method: PromoMethod;
  /** Null for an automatic discount. */
  readonly code: string | null;
  readonly title: string;
  readonly description: string;
  readonly kind: PromoKind;
  readonly valueBps: number | null;
  readonly valuePoisha: string | null;
  readonly buyQuantity: number | null;
  readonly getQuantity: number | null;
  readonly getDiscountBps: number | null;
  readonly tiers: readonly DiscountTier[];
  readonly minOrderPoisha: string | null;
  readonly minQuantity: number | null;
  readonly firstOrderOnly: boolean;
  readonly maxDiscountPoisha: string | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly usedCount: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly channels: readonly string[] | null;
  readonly productIds: readonly string[] | null;
  readonly categoryIds: readonly string[] | null;
  readonly customerId: string | null;
  readonly allowStacking: boolean;
  readonly priority: number;
  readonly origin: string;
  readonly status: PromoStatus;
}

export interface CreatePromoBody {
  readonly method?: PromoMethod;
  readonly code?: string;
  readonly title?: string;
  readonly description?: string;
  readonly kind: PromoKind;
  readonly valueBps?: number;
  readonly valuePoisha?: string;
  readonly buyQuantity?: number;
  readonly getQuantity?: number;
  readonly getDiscountBps?: number;
  readonly tiers?: readonly {
    readonly minSubtotalPoisha: string;
    readonly kind: 'percent' | 'flat';
    readonly valueBps?: number;
    readonly valuePoisha?: string;
  }[];
  readonly minOrderPoisha?: string;
  readonly minQuantity?: number;
  readonly firstOrderOnly?: boolean;
  readonly maxDiscountPoisha?: string;
  readonly totalLimit?: number;
  readonly perCustomerLimit?: number;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly channels?: readonly string[];
  readonly productIds?: readonly string[];
  readonly categoryIds?: readonly string[];
  readonly allowStacking?: boolean;
  readonly priority?: number;
}

export type FlashSaleStatus = 'draft' | 'scheduled' | 'live' | 'ended';

export interface FlashSaleSummary {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly slug: string;
  readonly enabled: boolean;
  readonly showOnHome: boolean;
  readonly priority: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly status: FlashSaleStatus;
  readonly skus: number;
  readonly unitsSold: number;
  /** Null when a SKU on the sale offers all its stock. */
  readonly unitsOffered: number | null;
}

export interface FlashSaleItem {
  readonly id: string;
  readonly skuId: string;
  readonly skuCode: string;
  readonly productId: string;
  readonly productName: string;
  readonly variantLabel: string | null;
  /** The SKU's selling price today. */
  readonly shelfPricePoisha: string;
  readonly salePricePoisha: string;
  /** Null: all the stock there is. */
  readonly unitLimit: number | null;
  readonly unitsSold: number;
  readonly enabled: boolean;
}

export interface FlashSale {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly slug: string;
  readonly bannerFileId: string | null;
  readonly enabled: boolean;
  readonly showOnHome: boolean;
  readonly priority: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly status: FlashSaleStatus;
  readonly items: readonly FlashSaleItem[];
}

export interface FlashSaleBody {
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly slug?: string;
  readonly bannerFileId: string | null;
  readonly enabled: boolean;
  readonly showOnHome: boolean;
  readonly priority: number;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly items: readonly {
    readonly skuId: string;
    readonly salePricePoisha: string;
    readonly unitLimit: number | null;
  }[];
}

export const TEMPLATE_CATEGORIES = ['otp', 'transactional', 'marketing'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** What a person may save: sign-in code templates are the system's (W4). */
export const EDITABLE_TEMPLATE_CATEGORIES = ['transactional', 'marketing'] as const;
export type EditableTemplateCategory = (typeof EDITABLE_TEMPLATE_CATEGORIES)[number];

export interface MessageTemplate {
  readonly id: string;
  readonly key: string;
  readonly channel: string;
  readonly category: TemplateCategory;
  readonly bodyBn: string;
  readonly bodyEn: string;
  readonly isActive: boolean;
}

export interface UpsertTemplateBody {
  readonly key: string;
  readonly category: EditableTemplateCategory;
  readonly bodyBn: string;
  readonly bodyEn: string;
  readonly isActive: boolean;
}

export interface OptOut {
  readonly id: string;
  readonly phone: string;
  readonly channel: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

export const MESSAGE_STATES = ['queued', 'sent', 'failed', 'suppressed'] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export interface SentMessage {
  readonly id: string;
  readonly templateKey: string;
  readonly category: string;
  readonly phone: string;
  readonly locale: string;
  readonly body: string;
  readonly state: MessageState;
  readonly sendAfter: string;
  readonly attempts: number;
  readonly provider: string | null;
  readonly error: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export const listPromoCodes = (status: PromoStatus | undefined, method?: PromoMethod) =>
  api.get<{ items: PromoCode[] }>(`/v1/promo/codes${query({ status, method, limit: 200 })}`);

export const createPromoCode = (body: CreatePromoBody) =>
  api.post<PromoCode>('/v1/promo/codes', body);

export const setPromoStatus = (id: string, status: PromoStatus) =>
  api.patch<PromoCode>(`/v1/promo/codes/${encodeURIComponent(id)}`, { status });

export const listTemplates = () => api.get<{ items: MessageTemplate[] }>('/v1/notify/templates');

export const upsertTemplate = (body: UpsertTemplateBody) =>
  api.put<MessageTemplate>('/v1/notify/templates', body);

export const listOptOuts = () => api.get<{ items: OptOut[] }>('/v1/notify/opt-outs');

export const addOptOut = (body: { phone: string; reason?: string }) =>
  api.post<unknown>('/v1/notify/opt-outs', body);

export const removeOptOut = (phone: string) =>
  api.delete<unknown>(`/v1/notify/opt-outs/${encodeURIComponent(phone)}`);

export const listMessages = (state: MessageState | undefined) =>
  api.get<{ items: SentMessage[] }>(`/v1/notify/messages${query({ state, limit: 200 })}`);

export const listFlashSales = () =>
  api.get<{ items: FlashSaleSummary[] }>('/v1/promo/flash-sales?limit=200');

export const getFlashSale = (id: string) =>
  api.get<FlashSale>(`/v1/promo/flash-sales/${encodeURIComponent(id)}`);

export const createFlashSale = (body: FlashSaleBody) =>
  api.post<FlashSale>('/v1/promo/flash-sales', body);

export const updateFlashSale = (id: string, body: FlashSaleBody) =>
  api.put<FlashSale>(`/v1/promo/flash-sales/${encodeURIComponent(id)}`, body);

export const setFlashSaleEnabled = (id: string, enabled: boolean) =>
  api.patch<FlashSale>(`/v1/promo/flash-sales/${encodeURIComponent(id)}`, { enabled });

export const duplicateFlashSale = (id: string) =>
  api.post<FlashSale>(`/v1/promo/flash-sales/${encodeURIComponent(id)}/duplicate`);
