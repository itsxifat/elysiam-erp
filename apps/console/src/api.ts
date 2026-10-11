import { env } from './env.js';

/**
 * The console's HTTP client (architecture §6, §25).
 *
 * Small and explicit rather than generated: M04 introduces the typed OpenAPI
 * client, and everything here is the handful of endpoints that exist before it.
 * What it must get right is the two things a generated client would not do for
 * us — carry cookies cross-origin, and echo the CSRF token back as a header.
 */

export const CSRF_COOKIE = 'erp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Methods the server treats as unable to change state, so never CSRF-checked. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Read the double-submit token the server set.
 *
 * Deliberately readable by script: that is the whole mechanism. An attacker's
 * page can make the browser *send* the cookie but cannot read it to echo it
 * into this header, because that would mean reading a cookie across origins.
 */
export function csrfToken(): string {
  for (const entry of document.cookie.split(';')) {
    const pair = entry.trim();
    if (pair.startsWith(`${CSRF_COOKIE}=`)) return pair.slice(CSRF_COOKIE.length + 1);
  }
  return '';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** The `code` from problem+json, when the server sent one. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the request never reached the server at all. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('the server could not be reached');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  /** Extra request headers, e.g. M41's owner acknowledgement (D-710). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...options.headers };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) {
    const token = csrfToken();
    if (token !== '') headers[CSRF_HEADER] = token;
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, env.VITE_API_URL), {
      method,
      headers,
      // The session and CSRF cookies live on the parent domain, and the console
      // is a different origin from the API. Without this they are simply not
      // sent, and every request looks anonymous.
      credentials: 'include',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    // A failed fetch is not a failed login, and telling the user their password
    // is wrong when the server is down sends them to reset it for nothing.
    throw new NetworkError(cause);
  }

  const text = await response.text();
  const payload: unknown = text === '' ? null : safeParse(text);

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

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type ExtraHeaders = Readonly<Record<string, string>> | undefined;

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: ExtraHeaders) =>
    request<T>(path, { method: 'POST', headers, ...(body === undefined ? {} : { body }) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', ...(body === undefined ? {} : { body }) }),
  patch: <T>(path: string, body?: unknown, headers?: ExtraHeaders) =>
    request<T>(path, { method: 'PATCH', headers, ...(body === undefined ? {} : { body }) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// --- shapes, mirroring what the server returns -----------------------------

export interface LoginBranding {
  readonly orgId: string | null;
  readonly slug: string | null;
  readonly displayName: string | null;
  readonly brand: {
    accent?: { hue?: number; chroma?: number };
    logo?: string;
    legalName?: string;
  } | null;
  readonly generic: boolean;
}

export interface AvailableOrg {
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface RequestContext {
  readonly userId: string;
  readonly orgId: string;
  readonly roles: readonly string[];
  readonly branchIds: readonly string[];
  readonly isSuperAdmin: boolean;
  readonly requestId: string;
}

export interface SignInResult {
  readonly twoFactorRedirect?: boolean;
}

export interface EnrolmentResult {
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}

export const endpoints = {
  branding: (host: string) =>
    api.get<LoginBranding>(`/v1/auth/login-branding?host=${encodeURIComponent(host)}`),
  /** An owner sign-in link's token for a session (M31, D-473). Sets the cookie; says no more. */
  ownerLink: (token: string) => api.post<{ ok: true }>('/v1/auth/owner-link', { token }),
  signIn: (email: string, password: string) =>
    api.post<SignInResult>('/api/auth/sign-in/email', { email, password }),
  signOut: () => api.post<unknown>('/api/auth/sign-out'),
  verifyTotp: (code: string) => api.post<unknown>('/api/auth/two-factor/verify-totp', { code }),
  verifyBackupCode: (code: string) =>
    api.post<unknown>('/api/auth/two-factor/verify-backup-code', { code }),
  enrol: (password: string) =>
    api.post<EnrolmentResult>('/api/auth/two-factor/enable', { password, method: 'totp' }),
  myOrgs: () => api.get<{ orgs: AvailableOrg[] }>('/v1/me/orgs'),
  me: () => api.get<RequestContext>('/v1/me'),
  /** Redeem an invite or reset link (gaps-users-auth). The token never goes in a URL here. */
  resetPassword: (token: string, newPassword: string) =>
    api.post<{ status: boolean }>('/api/auth/reset-password', { token, newPassword }),
  setActiveOrg: (orgId: string) =>
    api.post<{ orgId: string; roles: string[] }>('/v1/me/active-org', { orgId }),
};
