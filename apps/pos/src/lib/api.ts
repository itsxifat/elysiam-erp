import { env } from '../env.js';

/**
 * The till's HTTP client (architecture §6, §23, §25).
 *
 * Hand-written for the same reason as the console's `api.ts`: the generated client
 * types POS responses as `unknown` until integration regenerates it. What it must
 * get right is what a generated one would not: carry cookies cross-origin, echo the
 * CSRF double-submit token, and tell "the server said no" apart from "the server
 * could not be reached" — because the sync engine does opposite things with them.
 * A refusal is shown to a person; an unreachable server just means offline, and
 * the sale stays queued.
 */

export const CSRF_COOKIE = 'elysium_csrf';
export const CSRF_HEADER = 'x-elysium-csrf';

function csrfToken(): string {
  for (const entry of document.cookie.split(';')) {
    const pair = entry.trim();
    if (pair.startsWith(`${CSRF_COOKIE}=`)) return pair.slice(CSRF_COOKIE.length + 1);
  }
  return '';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never reached the server: offline, DNS, a dropped connection. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('the server could not be reached');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const token = csrfToken();
    if (token !== '') headers[CSRF_HEADER] = token;
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, env.VITE_API_URL), {
      method,
      headers,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const problem = (payload ?? {}) as { code?: unknown; detail?: unknown; message?: unknown };
    throw new ApiError(
      response.status,
      typeof problem.code === 'string' ? problem.code : null,
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.message === 'string'
          ? problem.message
          : response.statusText,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, 'POST', body),
};

// --- shapes, as the server returns them ---------------------------------------------

export interface AvailableOrg {
  readonly orgId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface RegisterView {
  readonly id: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly tenders: readonly ('cash' | 'bkash' | 'card')[];
}

export interface ReceiptHeader {
  readonly displayName: string;
  readonly legalName: string;
  readonly branchName: string;
  readonly address: string | null;
  readonly phone: string | null;
  readonly vatNo: string | null;
  readonly footer: string | null;
}

export interface Session {
  readonly register: RegisterView;
  readonly openShift: {
    readonly id: string;
    readonly shiftNo: number;
    readonly openedBy: string;
    readonly openedAt: string;
    readonly mine: boolean;
  } | null;
  readonly discountCeilingBps: number;
  readonly receiptHeader: ReceiptHeader;
  readonly serverTime: string;
  readonly businessDate: string;
  readonly userId: string;
}

export interface ShiftView {
  readonly id: string;
  readonly shiftNo: number;
  readonly status: 'open' | 'closed';
  readonly openingFloatPoisha: string;
  readonly countedCashPoisha: string | null;
  readonly expectedCashPoisha: string | null;
  readonly variancePoisha: string | null;
  readonly drawer?: {
    readonly expectedCashPoisha: string;
    readonly cashSalesPoisha: string;
    readonly cashRefundsPoisha: string;
    readonly salesCount: number;
    readonly heldCount: number;
  };
}

export interface SyncResult {
  readonly id: string;
  readonly kind: 'sale' | 'return';
  readonly outcome: 'posted' | 'held' | 'voided' | 'rejected' | 'conflict';
  readonly replayed: boolean;
  readonly reviewItemId: string | null;
  readonly reasons: readonly string[];
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface ReceiptLookup {
  readonly id: string;
  readonly receiptNo: string;
  readonly status: 'posted' | 'held' | 'voided';
  readonly occurredAt: string;
  readonly netPoisha: string;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly skuId: string;
    readonly skuCode: string;
    readonly name: string;
    readonly qty: number;
    readonly netPoisha: string;
    readonly returnableQty: number;
    readonly returnedQty: number;
  }[];
}

export const endpoints = {
  signIn: (email: string, password: string) =>
    api.post<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', { email, password }),
  verifyTotp: (code: string) => api.post<unknown>('/api/auth/two-factor/verify-totp', { code }),
  signOut: () => api.post<unknown>('/api/auth/sign-out'),
  myOrgs: () => api.get<{ orgs: AvailableOrg[] }>('/v1/me/orgs'),
  me: () => api.get<{ userId: string; orgId: string | null }>('/v1/me'),
  setActiveOrg: (orgId: string) => api.post<unknown>('/v1/me/active-org', { orgId }),
  registers: () => api.get<{ items: RegisterView[] }>('/v1/pos/registers'),
  session: (registerId: string) => api.get<Session>(`/v1/pos/registers/${registerId}/session`),
  priceList: (registerId: string, after: string | null) =>
    api.get<{ items: import('./cart.js').PriceListItem[]; next: string | null }>(
      `/v1/pos/registers/${registerId}/price-list?limit=500${after === null ? '' : `&after=${encodeURIComponent(after)}`}`,
    ),
  openShift: (body: { shiftId: string; registerId: string; openingFloatPoisha: string }) =>
    api.post<ShiftView>('/v1/pos/shifts', body),
  shift: (shiftId: string) => api.get<ShiftView>(`/v1/pos/shifts/${shiftId}`),
  closeShift: (shiftId: string, body: { countedCashPoisha: string; note?: string }) =>
    api.post<ShiftView>(`/v1/pos/shifts/${shiftId}/close`, body),
  sync: (documents: readonly unknown[]) =>
    api.post<{ results: SyncResult[] }>('/v1/pos/sync', { documents }),
  receipt: (receiptNo: string) =>
    api.get<{ items: ReceiptLookup[] }>(`/v1/pos/receipts/${encodeURIComponent(receiptNo)}`),
  checkPromo: (body: { registerId: string; code: string; basketPoisha: string }) =>
    api.post<{ valid: boolean; reason?: string }>('/v1/pos/promo-codes/check', body),
};
