import { createHash } from 'node:crypto';

import {
  assertParcelInput,
  PATHAO_STATUS_MAP,
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
import {
  courierRequest,
  instantAt,
  localPhone,
  objectAt,
  stringAt,
  takaAtAsPoisha,
} from './http.js';

/**
 * Pathao Courier (D-006, M15).
 *
 * ## UNVERIFIED — what it was built from, exactly
 *
 * Pathao's merchant API document is a JavaScript page behind the merchant portal and could
 * not be read from this build. What was read is Pathao's own engineering organisation's
 * open-source WooCommerce plugin, `pathao-eng/courier-woocommerce-plugin` — first-party in
 * authorship, second-hand as a specification. Everything below is labelled with where it
 * comes from:
 *
 * **From Pathao's plugin (first-party code):**
 * - the hosts: `api-hermes.pathao.com` (live) and `courier-api-sandbox.pathao.com` (staging);
 * - the login: `POST /aladdin/api/v1/external/login` with `client_id` and `client_secret`,
 *   answering `access_token`, `refresh_token`, `expires_in`;
 * - `Authorization: Bearer <token>` on every call;
 * - `POST /aladdin/api/v1/orders` and every field this adapter sends, and the answer's
 *   `data.consignment_id` and `data.delivery_fee`; `amount_to_collect` cast to an integer,
 *   `item_weight` to a float;
 * - the webhook: the `X-PATHAO-Signature` header compared against the merchant's webhook
 *   secret (which the plugin defaults to the client secret), the nineteen `event` names,
 *   the body's `consignment_id`, `merchant_order_id`, `order_status` and `event`, the
 *   `webhook_integration` handshake event, and the `202` answer carrying
 *   `X-Pathao-Merchant-Webhook-Integration-Secret`.
 *
 * **From community clients only (not first-party):**
 * - `GET /aladdin/api/v1/orders/{consignment_id}/info` for the polling fallback, and its
 *   `order_status_slug` / `order_status` / `updated_at`;
 * - the webhook's `collected_amount` and `timestamp` fields;
 * - that `recipient_city`, `recipient_zone` and `recipient_area` may be omitted. The plugin
 *   sends them (Pathao's own location ids); this ERP has no mapping to Pathao's ids, so it
 *   sends none. If Pathao refuses a parcel without them, the booking fails *non-retryably*
 *   with `COURIER_BOOKING_FAILED` on the first attempt — loudly, not silently.
 *
 * So `verified` is **false**, the adapter is off until `COURIER_PATHAO_ENABLED=true`, and the
 * switch is read at every use. It has never spoken to Pathao.
 *
 * ## Money
 *
 * `amount_to_collect` is whole taka — Pathao's plugin casts it with `(int)`. A COD with
 * poisha in it is **refused** rather than rounded: rounding would send a rider to collect a
 * different amount from the one our books expect, and the delivery journal would then post a
 * collection difference for a discrepancy we created. A person fixes the order instead.
 *
 * A partial-delivery webhook without `collected_amount` moves nothing (`orderTriggerFor` with
 * `collectedKnown: false`): the only figure left would be the full COD, which is wrong by
 * definition for a partial delivery.
 *
 * ## Idempotency (§9)
 *
 * §9 requires `createParcel` to be idempotent on our reference. Nothing first-party says
 * whether Pathao deduplicates `merchant_order_id`. If it does not, a booking retried after a
 * lost answer creates a second Pathao order — one with no box behind it, which never gets
 * picked up and surfaces in the stuck-parcel queue as `pickup_pending`. That is recorded as a
 * risk in decisions.md rather than papered over here.
 */

/**
 * Pathao's integration handshake constant.
 *
 * Not a secret of ours: it is Pathao's public protocol value, published in Pathao's own
 * GPL-licensed plugin, which every merchant endpoint returns so Pathao's panel accepts the
 * callback URL. It authenticates nothing in either direction — the merchant's own webhook
 * secret, checked on the way in, is what does that.
 */
const PATHAO_INTEGRATION_HEADER_VALUE = 'f3992ecc-59da-4cbe-a049-a13da2018d51';

/** Pathao's `delivery_type` for a normal (48-hour) delivery, per its plugin and clients. */
const DELIVERY_TYPE_NORMAL = 48;
/** Pathao's `item_type` for a parcel, as opposed to a document. */
const ITEM_TYPE_PARCEL = 2;
/** The least weight a parcel is declared at (M39b, D-645): the old blanket 500 g default. */
const PATHAO_MIN_WEIGHT_GRAMS = 500;

interface PathaoCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly storeId: string;
  /** Only for an account issued the password grant; see `COURIER_PATHAO_TOKEN_PATH`. */
  readonly username?: string;
  readonly password?: string;
}

function credentialsOf(context: AdapterContext): PathaoCredentials {
  const { clientId, clientSecret, storeId, username, password } = context.credentials;
  if (clientId === undefined || clientSecret === undefined || storeId === undefined) {
    throw new CourierError(
      'COURIER_CREDENTIALS_MISSING',
      'This Pathao account is missing its client id, client secret or store id.',
    );
  }
  return {
    clientId,
    clientSecret,
    storeId,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

export class PathaoCourierAdapter implements CourierAdapter {
  readonly code = 'pathao';
  readonly name = 'Pathao';
  /** Built from Pathao's plugin code and community clients, not its API document. */
  readonly verified = false;
  readonly statusMap = PATHAO_STATUS_MAP;
  readonly supportsWebhook = true;
  readonly credentialFields = ['clientId', 'clientSecret', 'storeId'];
  /** The password grant, for an account issued one (see `COURIER_PATHAO_TOKEN_PATH`). */
  readonly optionalCredentialFields = ['username', 'password'];
  readonly webhookAcknowledgement = {
    status: 202,
    headers: { 'X-Pathao-Merchant-Webhook-Integration-Secret': PATHAO_INTEGRATION_HEADER_VALUE },
  };

  /**
   * Access tokens, per account, until shortly before they expire.
   *
   * A token and not a credential: it is what Pathao hands back for the credentials, it
   * expires, and holding it saves a login round trip per parcel on a poll that asks about a
   * hundred. Keyed by a digest of the host and the credentials, so a rotated secret starts a
   * fresh entry instead of reusing a token issued for the old one, and never by the secret
   * itself. Capped at an hour whatever Pathao says, so a leaked heap dump holds a token that
   * dies soon.
   */
  private readonly tokens = new Map<string, CachedToken>();

  /** Test-only: forget every cached token. */
  resetTokens(): void {
    this.tokens.clear();
  }

  private baseUrl(context: AdapterContext): string {
    const env = courierEnv();
    const base =
      context.baseUrl ??
      (context.mode === 'live' ? env.COURIER_PATHAO_BASE_URL : env.COURIER_PATHAO_SANDBOX_BASE_URL);
    return base.replace(/\/+$/, '');
  }

  private cacheKey(context: AdapterContext, credentials: PathaoCredentials): string {
    return createHash('sha256')
      .update(`${this.baseUrl(context)}\n${credentials.clientId}\n${credentials.clientSecret}`)
      .digest('hex');
  }

  private async token(context: AdapterContext): Promise<string> {
    const credentials = credentialsOf(context);
    const key = this.cacheKey(context, credentials);
    const cached = this.tokens.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token;

    const { body } = await courierRequest({
      provider: 'Pathao',
      url: `${this.baseUrl(context)}${courierEnv().COURIER_PATHAO_TOKEN_PATH}`,
      method: 'POST',
      headers: {},
      body: {
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        /*
         * Only when the operator supplied them. Pathao's plugin logs in with the client pair
         * alone; community clients of the `issue-token` path add a password grant. Sending
         * the grant fields to a path that does not expect them is harmless; inventing them
         * for an account that has none would not be.
         */
        ...(credentials.username === undefined || credentials.password === undefined
          ? {}
          : {
              grant_type: 'password',
              username: credentials.username,
              password: credentials.password,
            }),
      },
      timeoutMs: context.timeoutMs,
    });

    const root = objectAt(body, null);
    const token = stringAt(objectAt(body, 'data') ?? root, 'access_token');
    if (token === null) {
      throw new CourierError(
        'COURIER_CREDENTIALS_MISSING',
        'Pathao issued no access token for these credentials.',
        false,
      );
    }
    const expiresIn = Number(stringAt(objectAt(body, 'data') ?? root, 'expires_in') ?? '0');
    const lifetimeSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    this.tokens.set(key, {
      token,
      // A minute early, and never beyond an hour.
      expiresAt: Date.now() + (Math.min(lifetimeSeconds, 3600) - 60) * 1000,
    });
    return token;
  }

  /**
   * One authenticated call, retried once with a fresh token when the cached one is refused.
   *
   * A token revoked before its stated expiry is ordinary, and failing a booking for it would
   * fail it for nothing — but only once: a second refusal is the credentials, not the token.
   */
  private async call(
    context: AdapterContext,
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.token(context);
      try {
        const { body } = await courierRequest({
          provider: 'Pathao',
          url: `${this.baseUrl(context)}${path}`,
          method: init.method,
          headers: { Authorization: `Bearer ${token}` },
          ...(init.body === undefined ? {} : { body: init.body }),
          timeoutMs: context.timeoutMs,
        });
        return body;
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof CourierError &&
          error.code === 'COURIER_CREDENTIALS_MISSING'
        ) {
          this.tokens.delete(this.cacheKey(context, credentialsOf(context)));
          continue;
        }
        throw error;
      }
    }
    throw new CourierError('COURIER_CREDENTIALS_MISSING', 'Pathao refused a fresh token.', false);
  }

  /**
   * Whether Pathao accepts these keys (D-913): the login this adapter makes before every call,
   * with the client id and secret (and the password grant, when given).
   *
   * A login refused for any reason a request can carry — 401, 403, or another 4xx about the
   * fields — is the keys, so all of them are one plain refusal. The store id is not something
   * the login checks, so it is checked here for being a store id at all, the way a booking
   * would refuse it later.
   */
  async verifyCredentials(context: AdapterContext): Promise<void> {
    const storeId = Number(context.credentials.storeId);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      throw new CourierError(
        'COURIER_CREDENTIALS_REJECTED',
        'The store id is a number. Copy it from Pathao’s merchant panel (Stores) and try again.',
      );
    }
    try {
      await this.token(context);
    } catch (error) {
      if (
        error instanceof CourierError &&
        (error.code === 'COURIER_CREDENTIALS_MISSING' || error.code === 'COURIER_BOOKING_FAILED')
      ) {
        throw new CourierError(
          'COURIER_CREDENTIALS_REJECTED',
          'Pathao did not accept this client id and client secret. Copy them again from Pathao’s merchant panel (Developer API) and try once more.',
        );
      }
      throw error;
    }
  }

  async createParcel(context: AdapterContext, input: ParcelInput): Promise<ParcelResult> {
    // Before any call: a parcel Pathao will always refuse must not cost five retries (§20).
    assertParcelInput(input);
    const credentials = credentialsOf(context);

    const cod: bigint = input.codAmountPoisha;
    if (cod % 100n !== 0n) {
      throw new CourierError(
        'CONSIGNMENT_INVALID',
        'Pathao collects whole taka only; this order’s COD has poisha in it. Correct the order before booking.',
        false,
      );
    }
    const storeId = Number(credentials.storeId);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      throw new CourierError(
        'COURIER_CREDENTIALS_MISSING',
        'This Pathao account’s store id is not a number.',
        false,
      );
    }

    // A weighed order's own weight (M39b, D-645), never under half a kilo, what every parcel
    // was declared at before weights existed (Pathao's own minimum is unverified, like the rest
    // of this adapter); the configured default when the order is not weighed.
    const grams = Math.max(
      PATHAO_MIN_WEIGHT_GRAMS,
      input.weightGrams ?? courierEnv().COURIER_PATHAO_DEFAULT_WEIGHT_GRAMS,
    );
    const address = [
      input.address.addressLine,
      input.address.area,
      input.address.thana,
      input.address.district,
    ]
      .filter((part): part is string => part !== null && part.trim() !== '')
      .join(', ');

    const body = await this.call(context, '/aladdin/api/v1/orders', {
      method: 'POST',
      body: {
        store_id: storeId,
        merchant_order_id: input.reference,
        recipient_name: input.address.recipientName,
        recipient_phone: localPhone(input.address.recipientPhoneE164),
        recipient_address: address,
        delivery_type: DELIVERY_TYPE_NORMAL,
        item_type: ITEM_TYPE_PARCEL,
        // One item: the parcel. Pathao handles by parcel, and this ERP books one per order.
        item_quantity: 1,
        // Kilograms. A weight, not money — the float Pathao's plugin sends it as is fine here.
        item_weight: grams / 1000,
        // Whole taka, as an integer: Pathao's plugin casts it with `(int)`. Exact, because the
        // remainder was refused above and ৳1 crore is far inside a safe integer.
        amount_to_collect: Number(cod / 100n),
        ...(input.itemDescription === null ? {} : { item_description: input.itemDescription }),
        ...(input.note === null ? {} : { special_instruction: input.note }),
      },
    });

    const data = objectAt(body, 'data');
    const consignmentNo = stringAt(data, 'consignment_id');
    if (consignmentNo === null) {
      /*
       * Accepted, and we cannot tell which parcel. Retryable — but see the idempotency note
       * on the class: whether the retry finds the same parcel is Pathao's to decide.
       */
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        'Pathao accepted the order but returned no consignment id.',
        true,
      );
    }

    return {
      consignmentNo,
      // Pathao's consignment id *is* what a customer tracks by on Pathao's site.
      trackingCode: consignmentNo,
      rawStatus: stringAt(data, 'order_status'),
    };
  }

  async getStatus(
    context: AdapterContext,
    ref: ParcelRef,
  ): Promise<{ rawStatus: string; occurredAt: Date | null; collectedPoisha: string | null }> {
    // Community-described, not first-party (see the class comment).
    const body = await this.call(
      context,
      `/aladdin/api/v1/orders/${encodeURIComponent(ref.consignmentNo)}/info`,
      { method: 'GET' },
    );
    const data = objectAt(body, 'data');
    const rawStatus = stringAt(data, 'order_status_slug') ?? stringAt(data, 'order_status');
    if (rawStatus === null) {
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        'Pathao returned no order status for that consignment.',
        true,
      );
    }
    return {
      rawStatus,
      occurredAt: instantAt(data, 'updated_at'),
      // The info answer carries no collected figure. Null means "not said", which is what a
      // partial delivery then waits on (see the class comment).
      collectedPoisha: null,
    };
  }

  /**
   * Verify and read one Pathao webhook (§9: "verify authenticity the way that courier
   * specifies").
   *
   * Pathao's way, per its plugin, is the merchant's webhook secret sent verbatim in
   * `X-PATHAO-Signature`. Compared in constant time. The secret is the account's own webhook
   * secret, falling back to its client secret exactly as Pathao's plugin does when the
   * merchant set none — both are secrets only this merchant and Pathao hold. An account with
   * neither accepts nothing.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- async so every refusal is a rejection, never a synchronous throw a caller did not expect
  async parseWebhook(
    context: AdapterContext,
    request: { headers: Readonly<Record<string, string | undefined>>; raw: Buffer },
  ): Promise<readonly RawCourierEvent[] | null> {
    const expected = context.credentials.webhookSecret ?? context.credentials.clientSecret;
    if (expected === undefined || expected === '') return null;

    const presented =
      request.headers['x-pathao-signature'] ?? request.headers['X-PATHAO-Signature'];
    if (presented === undefined || presented === '' || !secretMatches(presented, expected)) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(request.raw.toString('utf8'));
    } catch {
      throw new CourierError('CONSIGNMENT_EVENT_INVALID', 'That Pathao webhook body is not JSON.');
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const events: RawCourierEvent[] = [];
    for (const entry of entries) {
      const row = objectAt(entry, null);
      const event = stringAt(row, 'event');
      /*
       * The handshake Pathao sends when a merchant registers the callback URL, and any event
       * that is not about an order (Pathao's clients mention `store.*`). Authentic, so they
       * are accepted — and they name no parcel, so they produce no event.
       */
      if (event === 'webhook_integration') continue;
      if (event !== null && !event.startsWith('order.')) continue;

      const consignmentNo = stringAt(row, 'consignment_id');
      const rawStatus = stringAt(row, 'order_status') ?? event;
      if (consignmentNo === null || rawStatus === null) {
        // An order event naming no parcel or no status is not something to skip quietly:
        // it would leave a parcel at `shipped` with nothing saying why.
        throw new CourierError(
          'CONSIGNMENT_EVENT_INVALID',
          'A Pathao webhook names no consignment or no status.',
        );
      }

      events.push({
        consignmentNo,
        reference: stringAt(row, 'merchant_order_id'),
        rawStatus,
        occurredAt: instantAt(row, 'timestamp') ?? instantAt(row, 'updated_at'),
        collectedPoisha: takaAtAsPoisha(row, 'collected_amount'),
        // An allow-list: the recipient's name, phone and address never reach a jsonb column
        // (invariant 10), whatever Pathao adds to the body next.
        payload: {
          consignment_id: consignmentNo,
          merchant_order_id: stringAt(row, 'merchant_order_id'),
          event,
          order_status: stringAt(row, 'order_status'),
          updated_at: stringAt(row, 'updated_at'),
          timestamp: stringAt(row, 'timestamp'),
        },
      });
    }
    return events;
  }

  /**
   * A Pathao statement, as a column-mapped CSV (§9, D-124).
   *
   * Pathao publishes no statement format — the merchant panel exports a sheet — so this is
   * the same column-mapped parse Steadfast's uses, with the date read from the file's name.
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
