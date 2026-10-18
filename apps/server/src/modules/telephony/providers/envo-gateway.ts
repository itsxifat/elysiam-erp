import { maskPhonesInText } from '@elysium/domain';

/**
 * Envo's v1 API (M47, D-849), as `server/src/routes/v1.ts` in Envo's own source defines it. Built
 * from that source and its Developers page; unverified against the live service (Unverified
 * integrations).
 *
 * Every request carries `Authorization: Bearer <api key>` (`apiKeyAuth`) and goes only to the
 * connection's base URL, which the service has already checked is an https origin on a named host
 * (D-830). Redirects are refused, not followed, so a reply cannot send the key or a download
 * anywhere else. Envo answers errors as `{ error: "<sentence>" }`: 401 for a wrong or disabled
 * key, 403 for a missing scope, an origin or a package without the API, 402 for an inactive
 * account, 429 over 120 requests a minute per key, 400 for a request it refuses, 404 for what it
 * does not have. Nothing here is called inside a database transaction (invariant 6).
 */

export interface EnvoConnection {
  /** The connection's base URL: an origin, `https://envo.enfinito.cloud`. */
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface EnvoPing {
  readonly sipServer: { readonly id: number; readonly name: string; readonly slug: string } | null;
  readonly scopes: readonly string[];
  readonly keyName: string | null;
}

/** `GET /api/v1/extensions`: an extension with its live presence. */
export interface EnvoExtension {
  readonly extension: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly dnd: boolean;
  readonly webPhone: boolean;
  readonly online: boolean;
  /** Asterisk's device state: `idle`, `inuse`, `ringing`, `unavailable`… */
  readonly status: string;
}

/** `GET /api/v1/numbers`: a number of the SIP server and where its calls go. */
export interface EnvoNumber {
  readonly number: string;
  readonly label: string | null;
  readonly enabled: boolean;
  readonly destinationType: string | null;
  readonly destination: string | null;
  readonly trunk: string | null;
}

/** `GET /api/v1/calls/live`: one call in progress. */
export interface EnvoLiveCall {
  readonly id: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly state: string;
  readonly startedAt: string | null;
  readonly durationSec: number;
}

export interface EnvoCallHistoryPage {
  /** The rows as Envo sent them; `parseEnvoCall(row, 'sync')` reads each. */
  readonly calls: readonly unknown[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

export interface EnvoWebphoneToken {
  readonly token: string;
  readonly extension: string;
  readonly expiresAt: string;
  readonly sipDomain: string | null;
}

export type EnvoFailureKind =
  | 'refused'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'unreachable'
  | 'too_large'
  | 'unexpected';

/** Envo said no, or could not be asked. The message is Envo's own, masked; never the key. */
export class EnvoError extends Error {
  constructor(
    readonly kind: EnvoFailureKind,
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'EnvoError';
  }

  /** Worth trying again later: Envo was down, slow or busy. */
  get retryable(): boolean {
    return (
      this.kind === 'unreachable' ||
      this.kind === 'rate_limited' ||
      (this.status !== null && this.status >= 500)
    );
  }
}

export interface EnvoGateway {
  readonly provider: 'http' | 'fake';
  ping(connection: EnvoConnection): Promise<EnvoPing>;
  extensions(connection: EnvoConnection): Promise<readonly EnvoExtension[]>;
  numbers(connection: EnvoConnection): Promise<readonly EnvoNumber[]>;
  /** `POST /api/v1/calls`: ring `from` (an extension), then dial `to`. Envo answers 202. */
  originate(
    connection: EnvoConnection,
    input: { readonly from: string; readonly to: string },
  ): Promise<void>;
  /** `POST /api/v1/calls/hangup`: every channel of the call (or the channel) named. */
  hangup(connection: EnvoConnection, call: string): Promise<number>;
  liveCalls(connection: EnvoConnection): Promise<readonly EnvoLiveCall[]>;
  /** `GET /api/v1/calls?from&limit&page`: finished calls, newest first, one entry per call. */
  callHistory(
    connection: EnvoConnection,
    query: { readonly from: Date; readonly page: number; readonly limit: number },
  ): Promise<EnvoCallHistoryPage>;
  /** `POST /api/v1/webphone/token`: a short-lived token for one extension's web phone. */
  webphoneToken(
    connection: EnvoConnection,
    input: { readonly extension: string; readonly ttlSeconds: number },
  ): Promise<EnvoWebphoneToken>;
  /** `GET /api/v1/recordings/:id?download=1`, refusing (never truncating) past `maxBytes`. */
  downloadRecording(
    connection: EnvoConnection,
    recordingId: string,
    maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly mime: string | null }>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpEnvoOptions {
  readonly timeoutMs: number;
  readonly recordingTimeoutMs: number;
  readonly fetch?: Fetch;
}

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

/** What Envo said, short and masked: a refusal may quote a number it was given. */
function envoMessage(payload: unknown): string | null {
  const said = text((payload as { error?: unknown } | null)?.error, 200);
  return said === null ? null : maskPhonesInText(said);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'Envo';
  }
}

/** A refusal as a person reads it (acceptance check 1: "a wrong key is refused with a clear reason"). */
function failureFor(status: number, payload: unknown): EnvoError {
  const said = envoMessage(payload);
  switch (status) {
    case 401:
      return new EnvoError(
        'unauthorized',
        'Envo refused the API key: it is wrong, or it was turned off in Envo.',
        status,
      );
    case 402:
      return new EnvoError('refused', 'Envo says this account is not active.', status);
    case 403:
      return new EnvoError(
        'refused',
        `Envo refused: ${said ?? 'not allowed for this key.'}`,
        status,
      );
    case 404:
      return new EnvoError('not_found', `Envo has no such thing: ${said ?? 'not found.'}`, status);
    case 429:
      return new EnvoError(
        'rate_limited',
        'Envo’s limit of 120 requests a minute for this key was reached. Try again in a minute.',
        status,
      );
    default:
      if (status >= 500) {
        return new EnvoError('unreachable', `Envo had a problem (HTTP ${String(status)}).`, status);
      }
      return new EnvoError('refused', `Envo refused: ${said ?? `HTTP ${String(status)}.`}`, status);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new EnvoError('too_large', 'The recording is larger than the ERP keeps.', null);
  }
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new EnvoError('too_large', 'The recording is larger than the ERP keeps.', null);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function bareMime(value: string | null): string | null {
  if (value === null) return null;
  const mime = (value.split(';')[0] ?? '').trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]+$/.test(mime) ? mime : null;
}

export class HttpEnvoGateway implements EnvoGateway {
  readonly provider = 'http' as const;
  private readonly fetch: Fetch;

  constructor(private readonly options: HttpEnvoOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private async send(
    connection: EnvoConnection,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = this.options.timeoutMs,
  ): Promise<Response> {
    const url = `${connection.baseUrl.replace(/\/+$/, '')}${path}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${connection.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The cause can name the URL; the URL carries no secret, but a timeout's message is all a
      // person needs.
      throw new EnvoError(
        'unreachable',
        `Could not reach ${hostOf(connection.baseUrl)} in time.`,
        null,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new EnvoError(
        'unexpected',
        `${hostOf(connection.baseUrl)} redirected the request; the ERP does not follow it.`,
        response.status,
      );
    }
    return response;
  }

  private async json(
    connection: EnvoConnection,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.send(connection, method, path, body);
    const raw = await response.text();
    const payload = parseJson(raw);
    if (!response.ok) throw failureFor(response.status, payload);
    if (payload === null || typeof payload !== 'object') {
      throw new EnvoError(
        'unexpected',
        `${hostOf(connection.baseUrl)} did not answer as Envo does.`,
        response.status,
      );
    }
    return payload;
  }

  async ping(connection: EnvoConnection): Promise<EnvoPing> {
    const answer = (await this.json(connection, 'GET', '/api/v1/ping')) as {
      ok?: unknown;
      sipServer?: { id?: unknown; name?: unknown; slug?: unknown } | null;
      scopes?: unknown;
      key?: unknown;
    };
    if (answer.ok !== true) {
      throw new EnvoError('unexpected', 'Envo did not confirm the key.', null);
    }
    const server = answer.sipServer;
    return {
      sipServer:
        server !== null && server !== undefined && typeof server.id === 'number'
          ? { id: server.id, name: text(server.name, 80) ?? '', slug: text(server.slug, 80) ?? '' }
          : null,
      scopes: Array.isArray(answer.scopes)
        ? answer.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
      keyName: text(answer.key, 80),
    };
  }

  async extensions(connection: EnvoConnection): Promise<readonly EnvoExtension[]> {
    const answer = await this.json(connection, 'GET', '/api/v1/extensions');
    if (!Array.isArray(answer)) throw new EnvoError('unexpected', 'Envo sent no extensions.', null);
    return answer.flatMap((row: unknown) => {
      const record = row as Record<string, unknown>;
      const extension = text(record.extension, 8);
      if (extension === null || !/^[0-9]{2,8}$/.test(extension)) return [];
      return [
        {
          extension,
          name: text(record.name, 80) ?? extension,
          enabled: record.enabled === true,
          dnd: record.dnd === true,
          webPhone: record.webPhone === true,
          online: record.online === true,
          status: text(record.status, 20) ?? 'unavailable',
        },
      ];
    });
  }

  async numbers(connection: EnvoConnection): Promise<readonly EnvoNumber[]> {
    const answer = await this.json(connection, 'GET', '/api/v1/numbers');
    if (!Array.isArray(answer)) throw new EnvoError('unexpected', 'Envo sent no numbers.', null);
    return answer.flatMap((row: unknown) => {
      const record = row as Record<string, unknown>;
      const number = text(record.number, 32);
      if (number === null) return [];
      return [
        {
          number,
          label: text(record.label, 80),
          enabled: record.enabled !== false,
          destinationType: text(record.destination_type, 40),
          destination: text(record.destination, 80),
          trunk: text(record.trunk, 80),
        },
      ];
    });
  }

  async originate(
    connection: EnvoConnection,
    input: { readonly from: string; readonly to: string },
  ): Promise<void> {
    await this.json(connection, 'POST', '/api/v1/calls', { from: input.from, to: input.to });
  }

  async hangup(connection: EnvoConnection, call: string): Promise<number> {
    const answer = (await this.json(connection, 'POST', '/api/v1/calls/hangup', { call })) as {
      channels?: unknown;
    };
    return typeof answer.channels === 'number' ? answer.channels : 0;
  }

  async liveCalls(connection: EnvoConnection): Promise<readonly EnvoLiveCall[]> {
    const answer = (await this.json(connection, 'GET', '/api/v1/calls/live')) as {
      calls?: unknown;
    };
    if (!Array.isArray(answer.calls)) return [];
    return answer.calls.flatMap((row: unknown) => {
      const record = row as Record<string, unknown>;
      const id = text(record.id, 40);
      if (id === null || !/^[0-9]{1,20}(\.[0-9]{1,10})?$/.test(id)) return [];
      return [
        {
          id,
          from: text(record.from, 40),
          to: text(record.to, 40),
          state: text(record.state, 20) ?? 'unknown',
          startedAt: text(record.startedAt, 40),
          durationSec:
            typeof record.durationSec === 'number' && record.durationSec >= 0
              ? Math.round(record.durationSec)
              : 0,
        },
      ];
    });
  }

  async callHistory(
    connection: EnvoConnection,
    query: { readonly from: Date; readonly page: number; readonly limit: number },
  ): Promise<EnvoCallHistoryPage> {
    const search = new URLSearchParams({
      from: query.from.toISOString(),
      limit: String(query.limit),
      page: String(query.page),
    });
    const answer = (await this.json(connection, 'GET', `/api/v1/calls?${search.toString()}`)) as {
      calls?: unknown;
      total?: unknown;
      page?: unknown;
      limit?: unknown;
    };
    return {
      calls: Array.isArray(answer.calls) ? answer.calls : [],
      total: typeof answer.total === 'number' ? answer.total : Number(answer.total ?? 0) || 0,
      page: typeof answer.page === 'number' ? answer.page : query.page,
      limit: typeof answer.limit === 'number' ? answer.limit : query.limit,
    };
  }

  async webphoneToken(
    connection: EnvoConnection,
    input: { readonly extension: string; readonly ttlSeconds: number },
  ): Promise<EnvoWebphoneToken> {
    const answer = (await this.json(connection, 'POST', '/api/v1/webphone/token', {
      extension: input.extension,
      ttlSeconds: input.ttlSeconds,
    })) as { token?: unknown; extension?: unknown; expiresAt?: unknown; sipDomain?: unknown };
    const token = text(answer.token, 4096);
    if (token === null) throw new EnvoError('unexpected', 'Envo minted no token.', null);
    return {
      token,
      extension: text(answer.extension, 8) ?? input.extension,
      expiresAt:
        text(answer.expiresAt, 40) ?? new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      sipDomain: text(answer.sipDomain, 200),
    };
  }

  async downloadRecording(
    connection: EnvoConnection,
    recordingId: string,
    maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly mime: string | null }> {
    if (!/^[1-9][0-9]{0,17}$/.test(recordingId)) {
      throw new EnvoError('refused', 'That is not an Envo recording id.', null);
    }
    const response = await this.send(
      connection,
      'GET',
      `/api/v1/recordings/${recordingId}?download=1`,
      undefined,
      this.options.recordingTimeoutMs,
    );
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw failureFor(response.status, parseJson(raw));
    }
    return {
      bytes: await readCapped(response, maxBytes),
      mime: bareMime(response.headers.get('content-type')),
    };
  }
}

/** A 44-byte WAV header and a little silence: what the fake hands over as a recording. */
export function silentWav(seconds = 1): Uint8Array {
  const samples = 8000 * seconds;
  const data = samples * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, data, true);
  return bytes;
}

/**
 * Envo from memory, for a demo with no SIP server (`TELEPHONY_ENVO_PROVIDER=fake`): two
 * extensions online, one number, nothing live, an empty history, a token that is not one, and a
 * second of silence for any recording. It never rings a phone.
 */
export class FakeEnvoGateway implements EnvoGateway {
  readonly provider = 'fake' as const;
  readonly originated: { readonly from: string; readonly to: string }[] = [];

  ping(): Promise<EnvoPing> {
    return Promise.resolve({
      sipServer: { id: 1, name: 'Demo', slug: 'demo' },
      scopes: ['read', 'calls', 'webphone'],
      keyName: 'demo',
    });
  }

  extensions(): Promise<readonly EnvoExtension[]> {
    return Promise.resolve(
      ['101', '102', '103'].map((extension, index) => ({
        extension,
        name: `Desk ${String(index + 1)}`,
        enabled: true,
        dnd: false,
        webPhone: true,
        online: index < 2,
        status: index < 2 ? 'idle' : 'unavailable',
      })),
    );
  }

  numbers(): Promise<readonly EnvoNumber[]> {
    return Promise.resolve([
      {
        number: '09600000000',
        label: 'Hotline',
        enabled: true,
        destinationType: 'ring_group',
        destination: '600',
        trunk: 'Demo trunk',
      },
    ]);
  }

  originate(_connection: EnvoConnection, input: { readonly from: string; readonly to: string }) {
    this.originated.push(input);
    return Promise.resolve();
  }

  hangup(): Promise<number> {
    return Promise.resolve(0);
  }

  liveCalls(): Promise<readonly EnvoLiveCall[]> {
    return Promise.resolve([]);
  }

  callHistory(
    _connection: EnvoConnection,
    query: { readonly page: number; readonly limit: number },
  ): Promise<EnvoCallHistoryPage> {
    return Promise.resolve({ calls: [], total: 0, page: query.page, limit: query.limit });
  }

  webphoneToken(
    _connection: EnvoConnection,
    input: { readonly extension: string; readonly ttlSeconds: number },
  ): Promise<EnvoWebphoneToken> {
    return Promise.resolve({
      token: 'fake-envo-web-phone-token-not-a-real-one',
      extension: input.extension,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      sipDomain: null,
    });
  }

  downloadRecording(): Promise<{ readonly bytes: Uint8Array; readonly mime: string | null }> {
    return Promise.resolve({ bytes: silentWav(), mime: 'audio/wav' });
  }
}
