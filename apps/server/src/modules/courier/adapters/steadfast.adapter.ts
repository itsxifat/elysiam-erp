import {
  assertParcelInput,
  codAmountAsTaka,
  STEADFAST_STATUS_MAP,
  type ParcelInput,
  type ParcelRef,
  type ParcelResult,
} from '@elysium/domain/courier';

import { courierEnv } from '../courier.config.js';
import { CourierError } from '../courier.errors.js';
import { secretMatches } from '../credentials.js';
import { parseCsvStatement } from './csv-statement.js';
import type {
  AdapterContext,
  CourierAdapter,
  RawCourierEvent,
  SettlementBatch,
} from './courier-adapter.js';

/**
 * Steadfast Courier Limited — the phase-1 primary courier (D-006).
 *
 * ## UNVERIFIED. Read this before enabling it.
 *
 * §21 and CLAUDE.md both say the same thing: build an adapter from the courier's
 * official documentation and real credentials, and never invent an endpoint or a field.
 * Steadfast's API document lives behind a merchant-portal login that this build had no
 * account for. What was reachable, and what this file is built from, is Steadfast's own
 * `steadfast-it/SteadFast-Courier-Laravel-Package` README — first-party in authorship,
 * second-hand as a specification — plus the fact that the two public sources disagree
 * about the base URL (`portal.packzy.com/api/v1` and `portal.steadfast.com.bd/api/v1`).
 *
 * So nothing here is presented as verified:
 *
 * - `verified` is **false**, and `AccountsService` refuses to activate an account on an
 *   unverified adapter unless `COURIER_STEADFAST_ENABLED=true` says an operator has
 *   decided to try it.
 * - The base URL, the header names and the statement's column names are all
 *   configuration, so the first person with real credentials corrects a wrong guess with
 *   an environment variable instead of a deploy.
 * - Every response is parsed defensively and a missing field is a refusal naming the
 *   field, not an `undefined` that travels into a consignment row.
 * - The status vocabulary is the README's eleven values and the mapping test enumerates
 *   exactly those (acceptance check 2). If the real list is longer, an unmapped word
 *   becomes `unknown` with the raw text kept (§9) — visible, and not a silent no-op.
 *
 * A decisions.md row (D-176) says all of this in the place the client will read it, and
 * the report for this milestone says it too. When credentials arrive, the live sandbox
 * smoke test in `courier.adapter.test.ts` is the thing to run first.
 *
 * ## Why the fields are what they are
 *
 * `invoice`, `recipient_name`, `recipient_phone`, `recipient_address`, `cod_amount` and
 * `note` on create; `consignment_id`, `tracking_code` and `status` back. Those are the
 * names every published integration agrees on, which is weak evidence but consistent
 * evidence, and inventing better ones would be worse. `cod_amount` goes as **taka**, as
 * a string, because every Bangladeshi courier API takes taka — `codAmountAsTaka` is the
 * one boundary where poisha leaves the system, and it leaves as a string so no float can
 * get hold of it (invariant 1).
 */

interface SteadfastCredentials {
  readonly apiKey: string;
  readonly secretKey: string;
  /** The bearer token Steadfast presents on its webhook, when one is configured. */
  readonly webhookToken?: string;
}

function credentialsOf(context: AdapterContext): SteadfastCredentials {
  const apiKey = context.credentials.apiKey;
  const secretKey = context.credentials.secretKey;
  if (apiKey === undefined || secretKey === undefined) {
    throw new CourierError(
      'COURIER_CREDENTIALS_MISSING',
      'This Steadfast account is missing its API key or secret key.',
    );
  }
  return {
    apiKey,
    secretKey,
    ...(context.credentials.webhookToken === undefined
      ? {}
      : { webhookToken: context.credentials.webhookToken }),
  };
}

export class SteadfastCourierAdapter implements CourierAdapter {
  readonly code = 'steadfast';
  readonly name = 'Steadfast';
  /** See the file comment. Built from a first-party package README, not the API doc. */
  readonly verified = false;
  readonly statusMap = STEADFAST_STATUS_MAP;
  readonly supportsWebhook = true;
  readonly credentialFields = ['apiKey', 'secretKey', 'webhookToken'];

  /**
   * Whether Steadfast accepts these keys (D-913), asked with the status call this adapter
   * already polls with (`status_by_cid`), about a consignment that cannot exist.
   *
   * Steadfast's package documents no call made only to check keys that this adapter uses, and
   * an invented one is what CLAUDE.md forbids. A status question costs nothing and books
   * nothing: with good keys Steadfast answers about the parcel (that it has none such, in
   * whatever words), and with bad ones it refuses the keys — a 401 or 403, or a JSON answer
   * whose own `status` says 401 or 403, which is how its answers carry their status. Any other
   * answer means the keys got through. A courier that does not answer is `COURIER_UNAVAILABLE`.
   */
  async verifyCredentials(context: AdapterContext): Promise<void> {
    const rejected = new CourierError(
      'COURIER_CREDENTIALS_REJECTED',
      'Steadfast did not accept these keys. Copy the API key and the secret key again from Steadfast’s merchant panel (API settings) and try once more.',
    );
    let body: unknown;
    try {
      body = await this.call(context, 'status_by_cid/0', { method: 'GET' });
    } catch (error) {
      if (error instanceof CourierError && error.code === 'COURIER_CREDENTIALS_MISSING') {
        throw rejected;
      }
      // A 404 or a 422 about the made-up consignment: Steadfast read the keys and answered.
      if (error instanceof CourierError && error.code === 'COURIER_BOOKING_FAILED') return;
      throw error;
    }
    const status = readString(readObject(body, null), 'status');
    if (status === '401' || status === '403') throw rejected;
  }

  /**
   * The HTTP call, in one place.
   *
   * `fetch` with an `AbortSignal.timeout`, and the timeout is not optional: §20 gives a
   * job fifteen minutes before it is considered dead, and a courier that accepts the
   * connection and never answers would hold a worker slot for all fifteen. A request
   * that has not answered in `COURIER_HTTP_TIMEOUT_MS` is a retry.
   *
   * Nothing about the response body is logged here. A courier's error body echoes the
   * address and phone number we sent it (invariant 10), so the caller gets a status and
   * a code and the body is dropped.
   */
  private async call(
    context: AdapterContext,
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    const credentials = credentialsOf(context);
    const base = (context.baseUrl ?? courierEnv().COURIER_STEADFAST_BASE_URL).replace(/\/+$/, '');
    const url = `${base}/${path.replace(/^\/+/, '')}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers: {
          'Api-Key': credentials.apiKey,
          'Secret-Key': credentials.secretKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(context.timeoutMs),
      });
    } catch (error) {
      // A timeout, a DNS failure, a reset connection. All retryable: §20's five
      // attempts with backoff outlast a courier's restart.
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        `Steadfast did not answer (${error instanceof Error ? error.name : 'network error'}).`,
        true,
      );
    }

    if (response.status === 401 || response.status === 403) {
      // Not retryable. A revoked key does not come back, and five attempts against it
      // is five chances for the courier to rate-limit the whole account.
      throw new CourierError(
        'COURIER_CREDENTIALS_MISSING',
        'Steadfast rejected this account’s credentials.',
        false,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        `Steadfast answered ${String(response.status)}.`,
        true,
      );
    }
    if (!response.ok) {
      /*
       * A 4xx that is not auth and not a rate limit: the parcel is wrong, and sending
       * it again unchanged will be wrong again. Not retryable, so the job dead-letters
       * on the first attempt and `delivery.booking_failed` names it today rather than
       * in three minutes.
       */
      throw new CourierError(
        'COURIER_BOOKING_FAILED',
        `Steadfast refused this request (${String(response.status)}).`,
        false,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new CourierError('COURIER_UNAVAILABLE', 'Steadfast’s answer was not JSON.', true);
    }
  }

  async createParcel(context: AdapterContext, input: ParcelInput): Promise<ParcelResult> {
    // Before the call, not after: a parcel the courier will always refuse must not cost
    // five retries and a dead-lettered job (§20).
    assertParcelInput(input);

    const address = [
      input.address.addressLine,
      input.address.area,
      input.address.thana,
      input.address.district,
    ]
      .filter((part) => part !== null && part.trim() !== '')
      .join(', ');

    const body = await this.call(context, 'create_order', {
      method: 'POST',
      body: {
        invoice: input.reference,
        recipient_name: input.address.recipientName,
        /*
         * Local form, not E.164.
         *
         * Steadfast's published examples are all `01712345678`, and a Bangladeshi
         * courier's own validation is built for the local form. `+8801712345678` would
         * either be rejected or stored with a prefix the rider's app cannot dial.
         */
        recipient_phone: input.address.recipientPhoneE164.replace(/^\+880/, '0'),
        recipient_address: address,
        cod_amount: codAmountAsTaka(input.codAmountPoisha),
        ...(input.note === null ? {} : { note: input.note }),
      },
    });

    const consignment = readObject(readObject(body, 'consignment') ?? body, null);
    const consignmentNo = readString(consignment, 'consignment_id');
    if (consignmentNo === null) {
      /*
       * Accepted, and we cannot tell which parcel it accepted.
       *
       * Retryable, because `create_order` is idempotent on `invoice` (§9 requires it of
       * every adapter and Steadfast keys on the invoice), so the retry returns the same
       * parcel rather than creating a second one. Treating it as a failure instead would
       * leave a real parcel with a real COD that our books know nothing about.
       */
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        'Steadfast accepted the parcel but returned no consignment id.',
        true,
      );
    }

    return {
      consignmentNo,
      trackingCode: readString(consignment, 'tracking_code'),
      rawStatus: readString(consignment, 'status'),
    };
  }

  async getStatus(
    context: AdapterContext,
    ref: ParcelRef,
  ): Promise<{ rawStatus: string; occurredAt: Date | null; collectedPoisha: string | null }> {
    const body = await this.call(
      context,
      `status_by_cid/${encodeURIComponent(ref.consignmentNo)}`,
      { method: 'GET' },
    );
    const rawStatus = readString(readObject(body, null), 'delivery_status');
    if (rawStatus === null) {
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        'Steadfast returned no delivery_status for that consignment.',
        true,
      );
    }
    /*
     * No timestamp, and no invented one.
     *
     * The status endpoint returns a status and nothing about when it happened, so the
     * caller uses the moment of the poll — and records that it did, because a dedupe key
     * built from a poll time is weaker than one built from the courier's own instant. It
     * is still correct: the same status polled twice within a second is one event, and
     * polled again a minute later is deduped by the status not having changed.
     */
    return { rawStatus, occurredAt: null, collectedPoisha: null };
  }

  parseWebhook(
    context: AdapterContext,
    request: { headers: Readonly<Record<string, string | undefined>>; raw: Buffer },
  ): Promise<readonly RawCourierEvent[] | null> {
    const credentials = credentialsOf(context);
    const expected = credentials.webhookToken;

    /*
     * A bearer token, compared in constant time (§9: "verify authenticity the way that
     * courier specifies").
     *
     * An account with no token configured accepts nothing. The alternative — accept
     * everything when no secret is set — is the default that turns a public URL into a
     * way of marking any parcel delivered, which posts revenue and a courier receivable
     * for cash nobody collected.
     */
    if (expected === undefined) return Promise.resolve(null);

    const header = request.headers.authorization ?? request.headers.Authorization;
    const presented = header?.replace(/^Bearer\s+/i, '');
    if (presented === undefined || presented === '' || !secretMatches(presented, expected)) {
      return Promise.resolve(null);
    }

    let body: unknown;
    try {
      body = JSON.parse(request.raw.toString('utf8'));
    } catch {
      throw new CourierError('CONSIGNMENT_EVENT_INVALID', 'That webhook body is not JSON.');
    }

    const entries = Array.isArray(body) ? body : [body];
    const events: RawCourierEvent[] = [];
    for (const entry of entries) {
      const row = readObject(entry, null);
      const consignmentNo = readString(row, 'consignment_id');
      const rawStatus = readString(row, 'status') ?? readString(row, 'delivery_status');
      if (consignmentNo === null || rawStatus === null) {
        // A body that names no parcel or no status is not an event. Refused rather than
        // skipped: silently dropping it would leave a parcel stuck at `shipped` with
        // nothing anywhere saying why.
        throw new CourierError(
          'CONSIGNMENT_EVENT_INVALID',
          'A Steadfast webhook entry names no consignment or no status.',
        );
      }
      const updatedAt = readString(row, 'updated_at');
      const at = updatedAt === null ? null : new Date(updatedAt);
      events.push({
        consignmentNo,
        reference: readString(row, 'invoice'),
        rawStatus,
        occurredAt: at !== null && !Number.isNaN(at.getTime()) ? at : null,
        collectedPoisha: takaFieldToPoisha(row, 'cod_amount'),
        // An allow-list. Steadfast's webhook is documented as carrying only these, but
        // the body is somebody else's and a deny-list is one new field away from storing
        // a phone number in a jsonb column (invariant 10).
        payload: {
          consignment_id: consignmentNo,
          invoice: readString(row, 'invoice'),
          status: rawStatus,
          updated_at: updatedAt,
        },
      });
    }
    return Promise.resolve(events);
  }

  /**
   * Steadfast's settlement sheet, as a column-mapped CSV (§9).
   *
   * Steadfast publishes no settlement-file format at all — the merchant portal exports a
   * spreadsheet — so this is `parseCsvStatement` with the default column names, and the
   * names are configuration. The file's own name carries the statement date, because the
   * export does not put one in the sheet.
   */
  parseSettlementFile(
    _context: AdapterContext,
    file: Buffer,
    name: string,
  ): Promise<SettlementBatch> {
    const { rows } = parseCsvStatement(file);
    const date = /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
    if (date === undefined) {
      throw new CourierError(
        'SETTLEMENT_FILE_INVALID',
        'The statement’s date could not be read from its name; rename it to include YYYY-MM-DD.',
      );
    }
    return Promise.resolve({
      reference: /-(S\d+)\./i.exec(name)?.[1] ?? null,
      settlementDate: date,
      rows,
    });
  }
}

/** A nested object, or null. Never throws: the body is somebody else's. */
function readObject(value: unknown, key: string | null): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (key === null) return value as Record<string, unknown>;
  const nested = (value as Record<string, unknown>)[key];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return null;
  return nested as Record<string, unknown>;
}

/**
 * A string field, accepting a number where the courier sends one.
 *
 * `consignment_id` arrives as a JSON number in some published examples and as a string
 * in others. Coercing here rather than at four call sites, and coercing to *string*
 * rather than the other way, because a consignment number is an identifier: a
 * seventeen-digit id read as a JSON number has already lost its last digits.
 */
function readString(row: Record<string, unknown> | null, key: string): string | null {
  if (row === null) return null;
  const value = row[key];
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** A taka field as poisha, as a decimal string. Null when absent or unparseable. */
function takaFieldToPoisha(row: Record<string, unknown> | null, key: string): string | null {
  const raw = readString(row, key);
  if (raw === null) return null;
  const match = /^-?\d+(?:\.\d{1,2})?$/.exec(raw.replace(/[৳,\s]/g, ''));
  if (match === null) return null;
  const [whole, fraction = ''] = match[0].split('.');
  const sign = (whole ?? '').startsWith('-') ? -1n : 1n;
  const magnitude =
    BigInt((whole ?? '0').replace('-', '')) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return (sign * magnitude).toString();
}
