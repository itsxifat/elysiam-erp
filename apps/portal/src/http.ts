import { env } from './env.js';

/**
 * The portal's HTTP client for signed-in pages (the investor portal, M25).
 *
 * The same two rules as the console's client, because the portal is another origin talking
 * to the same API (D-053): send the cookies (`credentials: 'include'`), and echo the
 * `elysium_csrf` cookie back as a header on anything that is not a read. The tracking page
 * keeps its own one-call client (`tracking/api.ts`), which also primes that cookie for a
 * visitor with no session; here the session probe is always the first request, and any
 * request sets the cookie.
 */

export const CSRF_COOKIE = 'elysium_csrf';
export const CSRF_HEADER = 'x-elysium-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

/** The request never reached the server. Not a wrong password, and not a refusal. */
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
  readonly signal?: AbortSignal | undefined;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
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
      credentials: 'include',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
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
