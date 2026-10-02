import { api } from '../../api.js';

/**
 * `/v1/promo/*` and `/v1/notify/*`, typed to what the controllers return (M16).
 *
 * Hand-written for the reason the orders client gives. Amounts are decimal strings of
 * poisha; a promo code's value is either basis points (percent) or poisha (flat).
 */

export const PROMO_KINDS = ['percent', 'flat', 'free_delivery'] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];

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

export interface PromoCode {
  readonly id: string;
  readonly code: string;
  readonly kind: PromoKind;
  readonly valueBps: number | null;
  readonly valuePoisha: string | null;
  readonly minOrderPoisha: string | null;
  readonly maxDiscountPoisha: string | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly usedCount: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly channels: readonly string[] | null;
  readonly customerId: string | null;
  readonly origin: string;
  readonly status: PromoStatus;
}

export interface CreatePromoBody {
  readonly code: string;
  readonly kind: PromoKind;
  readonly valueBps?: number;
  readonly valuePoisha?: string;
  readonly minOrderPoisha?: string;
  readonly maxDiscountPoisha?: string;
  readonly totalLimit?: number;
  readonly perCustomerLimit?: number;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly channels?: readonly string[];
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

export const listPromoCodes = (status: PromoStatus | undefined) =>
  api.get<{ items: PromoCode[] }>(`/v1/promo/codes${query({ status, limit: 200 })}`);

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
