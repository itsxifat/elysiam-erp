import {
  assertParcelInput,
  codAmountAsTaka,
  REDX_STATUS_MAP,
  type ParcelInput,
  type ParcelRef,
  type ParcelResult,
} from '@elysium/domain/courier';

import { courierEnv } from '../courier.config.js';
import { CourierError } from '../courier.errors.js';
import { parseCsvStatement } from './csv-statement.js';
import type { AdapterContext, CourierAdapter, SettlementBatch } from './courier-adapter.js';
import { courierRequest, localPhone, objectAt, stringAt } from './http.js';

/**
 * RedX (D-006, M15).
 *
 * ## UNVERIFIED — and less verified than Pathao
 *
 * RedX's developer page renders nothing without a merchant session and could not be read.
 * The one source reachable was `redx-for-woocommerce`, a WordPress plugin by an individual
 * author with `shopupwp` among its contributors. It is **not** RedX's own SDK or
 * documentation (D-200), and it **creates parcels and does nothing else**, so:
 *
 * **From that plugin (third-party code, not a RedX document):**
 * - the host `https://openapi.redx.com.bd/v1.0.0-beta`;
 * - the header `API-ACCESS-TOKEN: Bearer <token>`;
 * - `POST /wordpress/parcel` with `customer_name`, `customer_phone`, `customer_address`,
 *   `merchant_invoice_id`, `cash_collection_amount`, `parcel_weight`, `instruction` and
 *   `value`, answering `tracking_id`.
 *
 * **From community clients only:**
 * - `GET /parcel/info/{tracking_id}` for the polling fallback, and `parcel.status` in it;
 * - that the general `POST /parcel` path needs a RedX `delivery_area_id`. This ERP has no
 *   mapping to RedX's area ids, which is why the create path defaults to the plugin's
 *   `/wordpress/parcel` (which takes none) and is configuration.
 *
 * **Not built, on purpose:**
 * - **No webhook.** Nothing first-party says how RedX authenticates a callback, and community
 *   descriptions show a body with no signature at all. §9 says "verify authenticity the way
 *   that courier specifies"; where the courier specifies nothing, a webhook would be a public
 *   URL that marks parcels delivered — which posts revenue and a courier receivable for cash
 *   nobody collected. RedX parcels are synced by the polling fallback only.
 * - **No cancel.** Only community clients describe one, as a generic "update" call.
 * - **No sandbox default.** No first-party source names a sandbox host; an account in
 *   sandbox mode is refused until `COURIER_REDX_SANDBOX_BASE_URL` is set.
 *
 * `verified` is false and the adapter is off until `COURIER_REDX_ENABLED=true`. It has never
 * spoken to RedX. Its status vocabulary (in the domain) is recalled from RedX's developer
 * page's webhook section, not read — see `REDX_STATUS_MAP`.
 */

interface RedxCredentials {
  readonly accessToken: string;
}

function credentialsOf(context: AdapterContext): RedxCredentials {
  const accessToken = context.credentials.accessToken;
  if (accessToken === undefined || accessToken === '') {
    throw new CourierError(
      'COURIER_CREDENTIALS_MISSING',
      'This RedX account is missing its API access token.',
    );
  }
  return { accessToken };
}

export class RedxCourierAdapter implements CourierAdapter {
  readonly code = 'redx';
  readonly name = 'RedX';
  /** Built from RedX's parcel-creation plugin and community clients, not its API document. */
  readonly verified = false;
  readonly statusMap = REDX_STATUS_MAP;
  /** No documented authenticity scheme, so no webhook (see the class comment). */
  readonly supportsWebhook = false;
  readonly credentialFields = ['accessToken'];

  private baseUrl(context: AdapterContext): string {
    const env = courierEnv();
    if (context.baseUrl !== undefined && context.baseUrl !== null) {
      return context.baseUrl.replace(/\/+$/, '');
    }
    if (context.mode === 'live') return env.COURIER_REDX_BASE_URL.replace(/\/+$/, '');
    if (env.COURIER_REDX_SANDBOX_BASE_URL === undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        'RedX has no sandbox host configured; set COURIER_REDX_SANDBOX_BASE_URL or the account’s base URL.',
        false,
      );
    }
    return env.COURIER_REDX_SANDBOX_BASE_URL.replace(/\/+$/, '');
  }

  private headers(context: AdapterContext): Record<string, string> {
    // The header name and the `Bearer ` prefix are exactly RedX's plugin's.
    return { 'API-ACCESS-TOKEN': `Bearer ${credentialsOf(context).accessToken}` };
  }

  async createParcel(context: AdapterContext, input: ParcelInput): Promise<ParcelResult> {
    assertParcelInput(input);

    const address = [
      input.address.addressLine,
      input.address.area,
      input.address.thana,
      input.address.district,
    ]
      .filter((part): part is string => part !== null && part.trim() !== '')
      .join(', ');

    const cod = codAmountAsTaka(input.codAmountPoisha);
    const { body } = await courierRequest({
      provider: 'RedX',
      url: `${this.baseUrl(context)}${courierEnv().COURIER_REDX_CREATE_PATH}`,
      method: 'POST',
      headers: this.headers(context),
      body: {
        customer_name: input.address.recipientName,
        customer_phone: localPhone(input.address.recipientPhoneE164),
        customer_address: address,
        merchant_invoice_id: input.reference,
        /*
         * Taka as a two-decimal string (invariant 1). RedX's plugin sends WooCommerce's order
         * total, which is a decimal too; a string keeps a float from ever holding it on our
         * side, and is what every Bangladeshi courier API parses.
         */
        cash_collection_amount: cod,
        // Grams, an integer, as the plugin sends it.
        parcel_weight: input.weightGrams ?? courierEnv().COURIER_REDX_DEFAULT_WEIGHT_GRAMS,
        instruction: input.note ?? '',
        // The declared value, which the plugin also sets to the order total.
        value: cod,
      },
      timeoutMs: context.timeoutMs,
    });

    const trackingId = stringAt(objectAt(body, null), 'tracking_id');
    if (trackingId === null) {
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        'RedX accepted the parcel but returned no tracking id.',
        true,
      );
    }
    // RedX's tracking id is both its parcel key and what a customer tracks by.
    return { consignmentNo: trackingId, trackingCode: trackingId, rawStatus: null };
  }

  /**
   * Whether RedX accepts this token (D-913), asked with the parcel-info call this adapter already
   * polls with, about a parcel that cannot exist: a 401 or 403 is the token, any other answer
   * means RedX read it.
   */
  async verifyCredentials(context: AdapterContext): Promise<void> {
    try {
      await courierRequest({
        provider: 'RedX',
        url: `${this.baseUrl(context)}/parcel/info/0`,
        method: 'GET',
        headers: this.headers(context),
        timeoutMs: context.timeoutMs,
      });
    } catch (error) {
      if (error instanceof CourierError && error.code === 'COURIER_CREDENTIALS_MISSING') {
        throw new CourierError(
          'COURIER_CREDENTIALS_REJECTED',
          'RedX did not accept this access token. Copy it again from RedX’s merchant panel and try once more.',
        );
      }
      if (error instanceof CourierError && error.code === 'COURIER_BOOKING_FAILED') return;
      throw error;
    }
  }

  async getStatus(
    context: AdapterContext,
    ref: ParcelRef,
  ): Promise<{ rawStatus: string; occurredAt: Date | null; collectedPoisha: string | null }> {
    // Community-described, not first-party (see the class comment).
    const { body } = await courierRequest({
      provider: 'RedX',
      url: `${this.baseUrl(context)}/parcel/info/${encodeURIComponent(ref.consignmentNo)}`,
      method: 'GET',
      headers: this.headers(context),
      timeoutMs: context.timeoutMs,
    });
    const parcel = objectAt(body, 'parcel') ?? objectAt(body, null);
    const rawStatus = stringAt(parcel, 'status');
    if (rawStatus === null) {
      throw new CourierError(
        'COURIER_UNAVAILABLE',
        'RedX returned no status for that parcel.',
        true,
      );
    }
    // No instant and no collected figure: neither is described anywhere for this call. The
    // poll time stands in for the instant (M12's arrangement), and a partial delivery with no
    // figure waits for a person.
    return { rawStatus, occurredAt: null, collectedPoisha: null };
  }

  /** A RedX statement, as a column-mapped CSV (§9, D-124); RedX publishes no format. */
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
