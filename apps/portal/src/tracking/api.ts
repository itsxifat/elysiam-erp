import { env } from '../env.js';

/**
 * The tracking page's one call (M15): `POST /v1/track`.
 *
 * ## Why a CSRF token for a page with no account
 *
 * The API's CSRF hook runs before any route and refuses every state-changing request that
 * does not echo its `elysium_csrf` cookie in a header — public routes included. The tracking
 * lookup is a `POST` (so the four digits never sit in a URL, an access log or a browser's
 * history), so the page first makes a cheap `GET` that the hook answers by setting the cookie,
 * then echoes it. The cookie lives on the parent domain the portal and the API share (D-053),
 * which is what lets the page read it. When the INTEGRATION notes' CSRF exemption for
 * `/v1/track` lands, the priming `GET` becomes unnecessary but stays harmless.
 */

const CSRF_COOKIE = 'elysium_csrf';
const CSRF_HEADER = 'x-elysium-csrf';

export type TrackingStage =
  | 'received'
  | 'processing'
  | 'with_courier'
  | 'out_for_delivery'
  | 'delivered'
  | 'returned'
  | 'cancelled';

export type TrackingStep =
  'received' | 'processing' | 'with_courier' | 'out_for_delivery' | 'delivered';

export interface TrackingFound {
  readonly found: true;
  readonly orderNo: string;
  readonly stage: TrackingStage;
  readonly steps: readonly { readonly step: TrackingStep; readonly reached: boolean }[];
  readonly courier: { readonly name: string; readonly trackingCode: string | null } | null;
  readonly lastUpdateOn: string | null;
  /** Integer poisha as a decimal string (invariant 1). */
  readonly codAmountPoisha: string;
}

export type TrackingResult =
  | { readonly kind: 'found'; readonly answer: TrackingFound }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'rate_limited' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'network' };

function readCookie(name: string): string {
  for (const entry of document.cookie.split(';')) {
    const pair = entry.trim();
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return '';
}

async function ensureCsrfCookie(): Promise<string> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing !== '') return existing;
  // Any request sets it; the liveness probe is the cheapest one the API has.
  await fetch(new URL('/health/live', env.VITE_API_URL), { credentials: 'include' });
  return readCookie(CSRF_COOKIE);
}

export async function track(input: {
  readonly brand: string;
  readonly orderNo: string;
  readonly phoneLast4: string;
}): Promise<TrackingResult> {
  let response: Response;
  try {
    const token = await ensureCsrfCookie();
    response = await fetch(new URL('/v1/track', env.VITE_API_URL), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(token === '' ? {} : { [CSRF_HEADER]: token }),
      },
      body: JSON.stringify(input),
    });
  } catch {
    return { kind: 'network' };
  }

  if (response.status === 429) return { kind: 'rate_limited' };
  if (response.status === 400) return { kind: 'invalid' };
  if (!response.ok) return { kind: 'network' };

  const body = (await response.json()) as { found?: unknown };
  return body.found === true
    ? { kind: 'found', answer: body as TrackingFound }
    : { kind: 'not_found' };
}
