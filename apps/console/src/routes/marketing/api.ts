import { api } from '../../api.js';

/**
 * `/v1/marketing/*`, typed to what the controller returns (M18).
 *
 * Hand-written for the reason the orders client gives. Amounts are decimal strings of
 * poisha; ratios are basis points as decimal strings (10,000 = 1× or 100%), and null where
 * the denominator is zero.
 */

export const PLATFORMS = ['meta', 'google', 'tiktok', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const REF_KINDS = ['meta_campaign', 'meta_ad', 'utm_campaign'] as const;
export type RefKind = (typeof REF_KINDS)[number];

export const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const AGE_BANDS = ['under_18', '18_24', '25_34', '35_44', '45_54', '55_plus'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const LEAD_DIMENSIONS = ['product', 'size', 'age_band', 'profession'] as const;
export type LeadDimension = (typeof LEAD_DIMENSIONS)[number];

export const LEAD_CHANNELS = [
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

export const CAPI_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;
export type CapiStatus = (typeof CAPI_STATUSES)[number];

export interface CampaignRef {
  readonly id: string;
  readonly kind: RefKind;
  readonly value: string;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly status: 'active' | 'archived';
  readonly origin: 'manual' | 'meta_import';
  readonly refs: readonly CampaignRef[];
}

export interface Metrics {
  readonly spendPoisha: string;
  readonly confirmedOrders: number;
  readonly deliveredOrders: number;
  readonly returnedOrders: number;
  readonly deliveredRevenuePoisha: string;
  readonly placedRevenuePoisha: string;
  readonly cpoPoisha: string | null;
  readonly cpdoPoisha: string | null;
  readonly roasBps: string | null;
  readonly placedRoasBps: string | null;
  readonly returnRateBps: string | null;
}

export interface SeriesPoint {
  readonly date: string;
  readonly spendPoisha: string;
  readonly deliveredRevenuePoisha: string;
}

export interface Dashboard {
  readonly from: string;
  readonly to: string;
  readonly total: Metrics;
  readonly campaigns: readonly {
    readonly campaignId: string;
    readonly name: string;
    readonly platform: Platform;
    readonly status: string;
    readonly metrics: Metrics;
  }[];
  readonly unattributed: Metrics | null;
  readonly attribution: Readonly<Record<'explicit' | 'ad_referral' | 'utm' | 'none', number>>;
  readonly series: readonly SeriesPoint[];
}

export interface SpendRow {
  readonly id: string;
  readonly campaignId: string;
  readonly spendDate: string;
  readonly amountPoisha: string;
  readonly source: 'manual' | 'meta';
  readonly note: string | null;
}

export interface CampaignChoice {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly status: string;
}

export interface Lead {
  readonly id: string;
  readonly phone: string;
  readonly name: string | null;
  readonly channel: string;
  readonly campaignId: string | null;
  readonly size: string | null;
  readonly ageBand: AgeBand | null;
  readonly profession: string | null;
  readonly status: LeadStatus;
  readonly notes: string | null;
  readonly createdAt: string;
}

export interface SegmentRow {
  readonly key: string | null;
  readonly label: string | null;
  readonly leads: number;
  readonly converted: number;
  readonly conversionBps: string;
}

export interface MetaConnection {
  readonly provider: 'fake' | 'graph';
  readonly adAccountId: string | null;
  readonly pixelId: string | null;
  readonly tokenConfigured: boolean;
  readonly tokenFingerprint: string | null;
  readonly spendImportEnabled: boolean;
  readonly capiEnabled: boolean;
  readonly sendNameAndCity: boolean;
  readonly testEventCode: string | null;
  readonly lastImportAt: string | null;
  readonly lastImportStatus: 'ok' | 'failed' | null;
  readonly lastImportError: string | null;
}

export interface Conversion {
  readonly id: string;
  readonly orderId: string;
  readonly status: CapiStatus;
  readonly attempts: number;
  readonly valuePoisha: string | null;
  readonly lastError: string | null;
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

export const getDashboard = (from: string, to: string) =>
  api.get<Dashboard>(`/v1/marketing/dashboard${query({ from, to })}`);

export const listCampaigns = () => api.get<{ items: Campaign[] }>('/v1/marketing/campaigns');

export const createCampaign = (body: {
  name: string;
  platform: Platform;
  startsOn?: string;
  endsOn?: string;
  refs?: { kind: RefKind; value: string }[];
}) => api.post<Campaign>('/v1/marketing/campaigns', body);

export const setCampaignStatus = (id: string, status: 'active' | 'archived') =>
  api.patch<Campaign>(`/v1/marketing/campaigns/${encodeURIComponent(id)}`, { status });

export const addRef = (id: string, body: { kind: RefKind; value: string }) =>
  api.post<Campaign>(`/v1/marketing/campaigns/${encodeURIComponent(id)}/refs`, body);

export const removeRef = (id: string, refId: string) =>
  api.delete<Campaign>(
    `/v1/marketing/campaigns/${encodeURIComponent(id)}/refs/${encodeURIComponent(refId)}`,
  );

export const listSpend = (from: string, to: string) =>
  api.get<{ items: SpendRow[] }>(`/v1/marketing/spend${query({ from, to })}`);

export const spendCampaigns = () =>
  api.get<{ items: CampaignChoice[] }>('/v1/marketing/spend/campaigns');

export const enterSpend = (body: {
  campaignId: string;
  spendDate: string;
  amountPoisha: string;
  note?: string;
}) => api.put<SpendRow>('/v1/marketing/spend', body);

export const requestImport = (from: string, to: string) =>
  api.post<{ queued: boolean }>('/v1/marketing/meta/import', { from, to });

export const listLeads = (status: LeadStatus | undefined) =>
  api.get<{ items: Lead[] }>(`/v1/marketing/leads${query({ status, limit: 200 })}`);

export const createLead = (body: {
  phone: string;
  channel: string;
  name?: string;
  size?: string;
  ageBand?: AgeBand;
  profession?: string;
  campaignId?: string;
}) => api.post<Lead>('/v1/marketing/leads', body);

export const setLeadStatus = (id: string, status: LeadStatus) =>
  api.patch<Lead>(`/v1/marketing/leads/${encodeURIComponent(id)}`, { status });

export const leadSegments = (dimension: LeadDimension) =>
  api.get<{ dimension: LeadDimension; total: number; rows: SegmentRow[] }>(
    `/v1/marketing/leads/segments${query({ dimension })}`,
  );

export const getConnection = () => api.get<MetaConnection>('/v1/marketing/meta-connection');

export const saveConnection = (body: {
  adAccountId?: string | null;
  pixelId?: string | null;
  token?: string;
  clearToken?: true;
  spendImportEnabled?: boolean;
  capiEnabled?: boolean;
  sendNameAndCity?: boolean;
  testEventCode?: string | null;
}) => api.put<MetaConnection>('/v1/marketing/meta-connection', body);

export const listConversions = (status: CapiStatus | undefined) =>
  api.get<{ items: Conversion[] }>(`/v1/marketing/capi-events${query({ status, limit: 200 })}`);
