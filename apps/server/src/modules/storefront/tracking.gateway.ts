/**
 * The two calls the website's tracking makes (M35b, D-552): Meta's Conversions API and GA4's
 * Measurement Protocol, ported from the old site's `lib/tracking/meta.js` and `ga4.js`.
 *
 * - **Meta**: `POST {base}/{version}/{dataset or pixel id}/events?access_token=…` with
 *   `{ data: [event], test_event_code? }`; the answer is `events_received` or an `error`.
 * - **GA4**: `POST {base}/mp/collect?measurement_id=…&api_secret=…` (or `/debug/mp/collect` in
 *   test mode, which answers with `validationMessages`), with the shopper's user agent as the
 *   request's, so GA4 attributes the device; production answers 204 with no body.
 *
 * Both were in use on the old site, and the ERP's ports have not yet spoken to either with a
 * brand's real credentials: UNVERIFIED (decisions.md), off unless
 * `STOREFRONT_TRACKING_PROVIDER=live` and `STOREFRONT_TRACKING_ENABLED=true`. Aligned with
 * M18's Meta gateway: the token and the API secret travel in query strings, so no URL is ever
 * logged or put into an error, and a failure says whether trying again could help.
 *
 * Never throws: each call returns what happened, so one platform failing never stops the other.
 */

export interface PlatformResult {
  readonly status: 'success' | 'error';
  /** Zero when nothing answered. */
  readonly httpStatus: number;
  readonly latencyMs: number;
  /** A short reason, never a URL and never a secret. Empty on success. */
  readonly error: string;
  /** What a person checking the log needs: Meta's receipt and trace id, GA4's validation. */
  readonly detail: Readonly<Record<string, unknown>>;
  /** Whether trying again could change the answer (a timeout, a 5xx, a 429). */
  readonly retryable: boolean;
}

export interface MetaSend {
  readonly apiVersion: string;
  /** The dataset id, or the pixel id when the brand gave no dataset. */
  readonly target: string;
  readonly token: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly testEventCode: string | null;
}

export interface Ga4Send {
  readonly measurementId: string;
  readonly apiSecret: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly userAgent: string | null;
  /** Test mode: GA4's validation endpoint, which records nothing. */
  readonly debug: boolean;
}

export interface TrackingGateway {
  /** `live` or `fake`: shown on Website → Tracking so nobody mistakes one for the other. */
  readonly provider: 'live' | 'fake';
  sendMeta(request: MetaSend): Promise<PlatformResult>;
  sendGa4(request: Ga4Send): Promise<PlatformResult>;
}

export const TRACKING_GATEWAY = Symbol('TrackingGateway');

/** Records what would have been sent and answers success; never opens a socket. */
export class FakeTrackingGateway implements TrackingGateway {
  readonly provider = 'fake' as const;
  readonly meta: MetaSend[] = [];
  readonly ga4: Ga4Send[] = [];
  /** Set to make the next Meta send fail, once. */
  failNextMeta: string | null = null;

  clear(): void {
    this.meta.length = 0;
    this.ga4.length = 0;
    this.failNextMeta = null;
  }

  sendMeta(request: MetaSend): Promise<PlatformResult> {
    if (this.failNextMeta !== null) {
      const error = this.failNextMeta;
      this.failNextMeta = null;
      return Promise.resolve({
        status: 'error',
        httpStatus: 400,
        latencyMs: 0,
        error,
        detail: {},
        retryable: false,
      });
    }
    this.meta.push(request);
    return Promise.resolve({
      status: 'success',
      httpStatus: 200,
      latencyMs: 0,
      error: '',
      detail: { eventsReceived: 1, fake: true },
      retryable: false,
    });
  }

  sendGa4(request: Ga4Send): Promise<PlatformResult> {
    this.ga4.push(request);
    return Promise.resolve({
      status: 'success',
      httpStatus: 204,
      latencyMs: 0,
      error: '',
      detail: { fake: true },
      retryable: false,
    });
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LiveGatewayOptions {
  readonly metaBaseUrl: string;
  readonly ga4BaseUrl: string;
  readonly timeoutMs: number;
  /** Injected so the adapter is tested against a stub, never against Meta or Google. */
  readonly fetch?: Fetch;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export class LiveTrackingGateway implements TrackingGateway {
  readonly provider = 'live' as const;
  private readonly fetch: Fetch;

  constructor(private readonly options: LiveGatewayOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** One call, timed; a transport failure never carries the URL (it holds the secret). */
  private async call(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response | null; latencyMs: number; failure: string }> {
    const started = Date.now();
    try {
      const response = await this.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      return { response, latencyMs: Date.now() - started, failure: '' };
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      return {
        response: null,
        latencyMs: Date.now() - started,
        failure: timedOut ? 'no answer in time' : 'could not be reached',
      };
    }
  }

  async sendMeta(request: MetaSend): Promise<PlatformResult> {
    const url = `${this.options.metaBaseUrl}/${encodeURIComponent(request.apiVersion)}/${encodeURIComponent(
      request.target,
    )}/events?${new URLSearchParams({ access_token: request.token }).toString()}`;
    const { response, latencyMs, failure } = await this.call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: [request.event],
        ...(request.testEventCode === null ? {} : { test_event_code: request.testEventCode }),
      }),
    });
    if (response === null) {
      return {
        status: 'error',
        httpStatus: 0,
        latencyMs,
        error: `Meta ${failure}.`,
        detail: {},
        retryable: true,
      };
    }
    let body: {
      events_received?: unknown;
      fbtrace_id?: unknown;
      error?: { message?: unknown; code?: unknown; fbtrace_id?: unknown };
    } | null;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = null;
    }
    const ok = response.ok && body?.error === undefined;
    return {
      status: ok ? 'success' : 'error',
      httpStatus: response.status,
      latencyMs,
      error: ok
        ? ''
        : `Meta refused it (HTTP ${String(response.status)}): ${text(body?.error?.message).slice(0, 300) || 'no message'}`,
      detail: {
        eventsReceived: typeof body?.events_received === 'number' ? body.events_received : 0,
        fbtraceId: text(body?.fbtrace_id ?? body?.error?.fbtrace_id) || null,
        ...(typeof body?.error?.code === 'number' ? { code: body.error.code } : {}),
      },
      retryable: !ok && (response.status >= 500 || response.status === 429),
    };
  }

  async sendGa4(request: Ga4Send): Promise<PlatformResult> {
    const path = request.debug ? '/debug/mp/collect' : '/mp/collect';
    const url = `${this.options.ga4BaseUrl}${path}?${new URLSearchParams({
      measurement_id: request.measurementId,
      api_secret: request.apiSecret,
    }).toString()}`;
    const { response, latencyMs, failure } = await this.call(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(request.userAgent === null || request.userAgent === ''
          ? {}
          : { 'user-agent': request.userAgent }),
      },
      body: JSON.stringify(request.payload),
    });
    if (response === null) {
      return {
        status: 'error',
        httpStatus: 0,
        latencyMs,
        error: `GA4 ${failure}.`,
        detail: {},
        retryable: true,
      };
    }
    let validation: unknown[] = [];
    if (request.debug) {
      try {
        const body = (await response.json()) as { validationMessages?: unknown };
        validation = Array.isArray(body.validationMessages) ? body.validationMessages : [];
      } catch {
        validation = [];
      }
    } else {
      await response.text().catch(() => '');
    }
    const ok = response.status >= 200 && response.status < 300 && validation.length === 0;
    return {
      status: ok ? 'success' : 'error',
      httpStatus: response.status,
      latencyMs,
      error: ok
        ? ''
        : validation.length > 0
          ? `GA4 found ${String(validation.length)} problem(s) with the event.`
          : `GA4 refused it (HTTP ${String(response.status)}).`,
      detail: validation.length > 0 ? { validationMessages: validation.slice(0, 5) } : {},
      retryable: !ok && (response.status >= 500 || response.status === 429),
    };
  }
}
