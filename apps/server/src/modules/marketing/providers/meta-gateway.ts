import type { CapiPurchaseEvent, MetaInsightRow } from '@elysium/domain/marketing';

/**
 * The two Meta calls the marketing module makes (architecture §11, §21; M18).
 *
 * Both adapters were written from Meta's own documentation, read on 2026-10-02, and have
 * never spoken to Meta: they are UNVERIFIED (D-257) and need two switches to turn on.
 *
 * - **Insights** — `GET /{version}/act_{ad-account-id}/insights` with `level=ad`,
 *   `time_increment=1`, `time_range={'since':…,'until':…}` and the fields `campaign_id`,
 *   `campaign_name`, `ad_id`, `spend`, `account_currency`, `date_start`, `date_stop`
 *   (Marketing API › Insights, and the Ad Account Insights reference). Paged by
 *   `paging.next`.
 * - **Conversions API** — `POST /{version}/{pixel-id}/events?access_token=…` with a body of
 *   `data` (up to 1,000 events) and an optional `test_event_code` (Conversions API ›
 *   Using the API). The answer carries `events_received` and `fbtrace_id`.
 *
 * The token travels in the query string because that is how both pages show it. So a URL
 * here is a secret: no adapter puts one in an error message, and nothing logs one.
 */

export interface InsightsRequest {
  /** Digits only; `act_` is added here. */
  readonly adAccountId: string;
  readonly token: string;
  /** Both inclusive, `YYYY-MM-DD`, in the ad account's own time zone. */
  readonly since: string;
  readonly until: string;
}

export interface CapiRequest {
  readonly pixelId: string;
  readonly token: string;
  readonly events: readonly CapiPurchaseEvent[];
  readonly testEventCode: string | null;
}

export interface CapiResponse {
  readonly eventsReceived: number;
  readonly fbtraceId: string | null;
  readonly messages: readonly string[];
}

/**
 * A refusal Meta named, or a transport failure.
 *
 * `retryable` is false for a 4xx with an error body — a bad token or an unknown pixel is
 * refused the same way next time — and true for a timeout, a network error or a 5xx.
 */
export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null,
    readonly metaCode: number | null,
    readonly fbtraceId: string | null,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

export interface MetaGateway {
  /** `graph` or `fake`: shown on the settings screen so nobody mistakes one for the other. */
  readonly provider: 'graph' | 'fake';
  fetchInsights(request: InsightsRequest): Promise<MetaInsightRow[]>;
  sendEvents(request: CapiRequest): Promise<CapiResponse>;
}

export const META_GATEWAY = Symbol('MetaGateway');

/**
 * The default everywhere until a brand's real credentials exist: imports what a test
 * gives it and records what would have been sent. It never opens a socket.
 */
export class FakeMetaGateway implements MetaGateway {
  readonly provider = 'fake' as const;
  private rows: MetaInsightRow[] = [];
  readonly sent: CapiRequest[] = [];
  /** Set to make the next send fail, once. */
  failNextSend: MetaApiError | null = null;

  setInsights(rows: readonly MetaInsightRow[]): void {
    this.rows = [...rows];
  }

  clear(): void {
    this.rows = [];
    this.sent.length = 0;
    this.failNextSend = null;
  }

  fetchInsights(request: InsightsRequest): Promise<MetaInsightRow[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.dateStart >= request.since && row.dateStart <= request.until),
    );
  }

  sendEvents(request: CapiRequest): Promise<CapiResponse> {
    if (this.failNextSend !== null) {
      const failure = this.failNextSend;
      this.failNextSend = null;
      return Promise.reject(failure);
    }
    this.sent.push(request);
    return Promise.resolve({
      eventsReceived: request.events.length,
      fbtraceId: 'fake-trace',
      messages: [],
    });
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GraphGatewayOptions {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
  /** Injected so the adapter is tested against a stub, never against Meta. */
  readonly fetch?: Fetch;
}

/** The most Insights pages one import follows; a brand's daily ad rows fit in a few. */
const MAX_PAGES = 50;

interface GraphErrorBody {
  readonly error?: {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly fbtrace_id?: unknown;
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export class GraphMetaGateway implements MetaGateway {
  readonly provider = 'graph' as const;
  private readonly fetch: Fetch;

  constructor(private readonly options: GraphGatewayOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private root(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/${this.options.apiVersion}`;
  }

  /** One call. Never lets the URL — which holds the token — into an error. */
  private async call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new MetaApiError(
        timedOut ? 'Meta did not answer in time.' : 'Meta could not be reached.',
        true,
        null,
        null,
        null,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const error = (body as GraphErrorBody | null)?.error;
      const code = typeof error?.code === 'number' ? error.code : null;
      throw new MetaApiError(
        `Meta refused the request (HTTP ${String(response.status)}${
          code === null ? '' : `, code ${String(code)}`
        }): ${text(error?.message).slice(0, 300) || 'no message'}`,
        response.status >= 500 || response.status === 429 || error === undefined,
        response.status,
        code,
        text(error?.fbtrace_id) || null,
      );
    }
    return body;
  }

  async fetchInsights(request: InsightsRequest): Promise<MetaInsightRow[]> {
    const params = new URLSearchParams({
      level: 'ad',
      fields: 'campaign_id,campaign_name,ad_id,spend,account_currency,date_start,date_stop',
      time_range: JSON.stringify({ since: request.since, until: request.until }),
      time_increment: '1',
      limit: '500',
      access_token: request.token,
    });
    let url: string | null =
      `${this.root()}/act_${encodeURIComponent(request.adAccountId)}/insights?${params.toString()}`;

    const rows: MetaInsightRow[] = [];
    for (let page = 0; url !== null; page += 1) {
      if (page >= MAX_PAGES) {
        throw new MetaApiError(
          'Meta returned more pages than one import reads.',
          false,
          null,
          null,
          null,
        );
      }
      const body = (await this.call(url, { method: 'GET' })) as {
        readonly data?: readonly Record<string, unknown>[];
        readonly paging?: { readonly next?: unknown };
      } | null;
      for (const item of body?.data ?? []) {
        rows.push({
          campaignId: text(item.campaign_id),
          campaignName: text(item.campaign_name),
          adId: text(item.ad_id) || null,
          accountCurrency: text(item.account_currency),
          dateStart: text(item.date_start),
          dateStop: text(item.date_stop),
          spend: text(item.spend),
        });
      }
      // Followed only on the configured host: the next URL carries the token, and a page
      // pointing anywhere else would hand it to whoever answered.
      const next = body?.paging?.next;
      url =
        typeof next === 'string' && next.startsWith(`${this.options.baseUrl.replace(/\/+$/, '')}/`)
          ? next
          : null;
    }
    return rows;
  }

  async sendEvents(request: CapiRequest): Promise<CapiResponse> {
    const url = `${this.root()}/${encodeURIComponent(request.pixelId)}/events?${new URLSearchParams(
      { access_token: request.token },
    ).toString()}`;
    const body = (await this.call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: request.events,
        ...(request.testEventCode === null ? {} : { test_event_code: request.testEventCode }),
      }),
    })) as { events_received?: unknown; fbtrace_id?: unknown; messages?: unknown } | null;
    return {
      eventsReceived: typeof body?.events_received === 'number' ? body.events_received : 0,
      fbtraceId: text(body?.fbtrace_id) || null,
      messages: Array.isArray(body?.messages) ? body.messages.map((message) => text(message)) : [],
    };
  }
}
