import type {
  ActivityWire,
  BrandCreateInput,
  BrandFiguresWire,
  BrandLiveResult,
  BrandStatusWire,
  BrandUpdateInput,
  ConnectionTestWire,
  LeaderboardWire,
  LinkWire,
  MeWire,
  OverviewWire,
  OwnerLinkKeyWire,
  OwnerLinkWire,
  PersonWire,
  ProfitAndLossWire,
  TwoFactorResetWire,
  WalletsWire,
} from '@elysium/mother-shared';

/**
 * The owner console's HTTP client (D-491). Same origin as the API, so paths are relative
 * and cookies travel without CORS; writes echo the CSRF cookie in a header.
 */

const CSRF_COOKIE = 'owner_csrf';
const CSRF_HEADER = 'x-owner-csrf';
const SAFE = new Set(['GET', 'HEAD']);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly fields: readonly { readonly path: string; readonly message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  constructor() {
    super('the server could not be reached');
    this.name = 'NetworkError';
  }
}

function csrfToken(): string {
  for (const entry of document.cookie.split(';')) {
    const pair = entry.trim();
    if (pair.startsWith(`${CSRF_COOKIE}=`)) return pair.slice(CSRF_COOKIE.length + 1);
  }
  return '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (!SAFE.has(method)) {
    // The cookie is handed out on a safe request; make one if this is the first call.
    if (csrfToken() === '') await fetch('/v1/health/live', { credentials: 'same-origin' });
    headers[CSRF_HEADER] = csrfToken();
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new NetworkError();
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const problem = (payload ?? {}) as {
      code?: unknown;
      detail?: unknown;
      message?: unknown;
      errors?: unknown;
    };
    throw new ApiError(
      response.status,
      typeof problem.code === 'string' ? problem.code : null,
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.message === 'string'
          ? problem.message
          : response.statusText,
      Array.isArray(problem.errors) ? (problem.errors as { path: string; message: string }[]) : [],
    );
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body);

export interface EnrolmentResult {
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}

const range = (from: string, to: string) =>
  `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

export const endpoints = {
  // Sign-in (Better Auth, D-487)
  signIn: (email: string, password: string) =>
    post<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', { email, password }),
  verifyTotp: (code: string) => post<unknown>('/api/auth/two-factor/verify-totp', { code }),
  verifyBackupCode: (code: string) =>
    post<unknown>('/api/auth/two-factor/verify-backup-code', { code }),
  enrol: (password: string) => post<EnrolmentResult>('/api/auth/two-factor/enable', { password }),
  signOut: () => post<unknown>('/api/auth/sign-out'),
  setPassword: (token: string, newPassword: string) =>
    post<unknown>('/api/auth/reset-password', { token, newPassword }),

  me: () => get<MeWire>('/v1/me'),

  // Figures (D-484 to D-493)
  overview: (from: string, to: string) => get<OverviewWire>(`/v1/overview?${range(from, to)}`),
  leaderboard: (month: string) =>
    get<LeaderboardWire>(`/v1/leaderboard?month=${encodeURIComponent(month)}`),
  wallets: () => get<WalletsWire>('/v1/accounts/wallets'),
  profitAndLoss: (from: string, to: string) =>
    get<ProfitAndLossWire>(`/v1/accounts/profit-and-loss?${range(from, to)}`),

  // Brands (D-481, D-490)
  brands: () => get<{ brands: BrandStatusWire[] }>('/v1/brands'),
  brand: (id: string) => get<BrandStatusWire>(`/v1/brands/${id}`),
  brandFigures: (id: string, from: string, to: string) =>
    get<BrandFiguresWire>(`/v1/brands/${id}/figures?${range(from, to)}`),
  brandLive: (id: string) => get<BrandLiveResult>(`/v1/brands/${id}/live`),
  addBrand: (input: BrandCreateInput) => post<BrandStatusWire>('/v1/brands', input),
  updateBrand: (id: string, input: BrandUpdateInput) =>
    patch<BrandStatusWire>(`/v1/brands/${id}`, input),
  testBrand: (id: string) => post<ConnectionTestWire>(`/v1/brands/${id}/test`),
  rotateKey: (id: string) => post<OwnerLinkKeyWire>(`/v1/brands/${id}/owner-link-key`),
  pull: (id: string, full: boolean) => post<{ queued: true }>(`/v1/brands/${id}/pull`, { full }),
  ownerLink: (id: string) => post<OwnerLinkWire>(`/v1/brands/${id}/owner-link`),

  // People (D-487 to D-489)
  people: () => get<{ people: PersonWire[]; resets: TwoFactorResetWire[] }>('/v1/people'),
  invite: (email: string, name: string) => post<LinkWire>('/v1/people', { email, name }),
  reissueInvite: (id: string) => post<LinkWire>(`/v1/people/${id}/invite-link`),
  removePerson: (id: string) => post<{ ok: true }>(`/v1/people/${id}/remove`),
  requestReset: (id: string, reason: string) =>
    post<{ id: string }>(`/v1/people/${id}/two-factor-resets`, { reason }),
  decideReset: (id: string, decision: 'approve' | 'reject') =>
    post<{ ok: true }>(`/v1/two-factor-resets/${id}/${decision}`),

  activity: (before?: number) =>
    get<ActivityWire>(
      `/v1/activity?limit=50${before === undefined ? '' : `&before=${String(before)}`}`,
    ),
};
