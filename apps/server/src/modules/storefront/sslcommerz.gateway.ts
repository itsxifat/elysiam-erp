import type { GatewayValidation } from '@elysium/domain/storefront';

/**
 * SSLCommerz (M34, D-525): opening a payment session and asking whether a payment is valid.
 *
 * Built from SSLCommerz's developer documentation (API v4: `gwprocess/v4/api.php` for the
 * session, `validator/api/validationserverAPI.php` for the Order Validation API, sandbox host
 * `sandbox.sslcommerz.com`, live host `securepay.sslcommerz.com`) and the old website's working
 * `sslcommerz-lts` flow, which posts the session as multipart form data and validates with a GET.
 * **UNVERIFIED** until a sandbox run (decisions.md, "Unverified integrations").
 *
 * Called only by the worker, with no database transaction open (invariant 6). The store
 * password is handed in per call, opened from its sealed column just before; nothing here keeps
 * it, logs it, or puts it in an error.
 */

export interface GatewayCredentials {
  readonly storeId: string;
  readonly storePassword: string;
  readonly mode: 'sandbox' | 'live';
}

export interface SessionRequest {
  readonly tranId: string;
  /** `1250.00`: taka with two decimals (`gatewayAmount`). */
  readonly totalAmount: string;
  readonly successUrl: string;
  readonly failUrl: string;
  readonly cancelUrl: string;
  readonly ipnUrl: string;
  readonly customer: {
    readonly name: string;
    readonly email: string;
    readonly phone: string;
    readonly address: string;
    readonly city: string;
  };
  readonly productName: string;
  readonly itemCount: number;
}

export type SessionResult =
  | { readonly ok: true; readonly gatewayUrl: string; readonly sessionKey: string | null }
  | {
      readonly ok: false;
      /** `failed` (SSLCommerz said FAILED), `timeout`, `http_<status>`, `unrecognised`. */
      readonly error: string;
    };

export type ValidationResult =
  | { readonly ok: true; readonly answer: GatewayValidation & Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

export interface PaymentGateway {
  readonly name: string;
  readonly verified: boolean;
  openSession(
    credentials: GatewayCredentials,
    request: SessionRequest,
    options: { readonly timeoutMs: number },
  ): Promise<SessionResult>;
  validate(
    credentials: GatewayCredentials,
    valId: string,
    options: { readonly timeoutMs: number },
  ): Promise<ValidationResult>;
}

export const PAYMENT_GATEWAY = Symbol('PaymentGateway');

const HOSTS = {
  sandbox: 'https://sandbox.sslcommerz.com',
  live: 'https://securepay.sslcommerz.com',
} as const;

/** SSLCommerz's field limits (its documentation): cut to fit rather than be refused. */
function fit(value: string, max: number): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

export class SslcommerzGateway implements PaymentGateway {
  readonly name = 'sslcommerz';
  readonly verified = false;

  async openSession(
    credentials: GatewayCredentials,
    request: SessionRequest,
    options: { readonly timeoutMs: number },
  ): Promise<SessionResult> {
    const form = new FormData();
    const fields: Record<string, string> = {
      store_id: credentials.storeId,
      store_passwd: credentials.storePassword,
      total_amount: request.totalAmount,
      currency: 'BDT',
      tran_id: request.tranId,
      success_url: request.successUrl,
      fail_url: request.failUrl,
      cancel_url: request.cancelUrl,
      ipn_url: request.ipnUrl,
      shipping_method: 'Courier',
      product_name: fit(request.productName, 255),
      product_category: 'Clothing',
      product_profile: 'physical-goods',
      num_of_item: String(Math.max(1, Math.min(9, request.itemCount))),
      cus_name: fit(request.customer.name, 50),
      cus_email: fit(request.customer.email, 50),
      cus_add1: fit(request.customer.address, 50),
      cus_city: fit(request.customer.city, 50),
      cus_postcode: '1000',
      cus_country: 'Bangladesh',
      cus_phone: fit(request.customer.phone, 20),
      ship_name: fit(request.customer.name, 50),
      ship_add1: fit(request.customer.address, 50),
      ship_city: fit(request.customer.city, 50),
      ship_postcode: '1000',
      ship_country: 'Bangladesh',
    };
    for (const [key, value] of Object.entries(fields)) form.append(key, value);

    let response: Response;
    try {
      response = await fetch(`${HOSTS[credentials.mode]}/gwprocess/v4/api.php`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      return { ok: false, error: isTimeout(error) ? 'timeout' : 'network' };
    }
    if (!response.ok) return { ok: false, error: `http_${String(response.status)}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: 'unrecognised' };
    }
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const url = record.GatewayPageURL;
    if (record.status === 'SUCCESS' && typeof url === 'string' && url.startsWith('https://')) {
      const key = record.sessionkey;
      return {
        ok: true,
        gatewayUrl: url,
        sessionKey: typeof key === 'string' ? key.slice(0, 200) : null,
      };
    }
    return { ok: false, error: record.status === 'FAILED' ? 'failed' : 'unrecognised' };
  }

  async validate(
    credentials: GatewayCredentials,
    valId: string,
    options: { readonly timeoutMs: number },
  ): Promise<ValidationResult> {
    const query = new URLSearchParams({
      val_id: valId,
      store_id: credentials.storeId,
      store_passwd: credentials.storePassword,
      v: '1',
      format: 'json',
    });
    let response: Response;
    try {
      response = await fetch(
        `${HOSTS[credentials.mode]}/validator/api/validationserverAPI.php?${query.toString()}`,
        { method: 'GET', signal: AbortSignal.timeout(options.timeoutMs) },
      );
    } catch (error) {
      return { ok: false, error: isTimeout(error) ? 'timeout' : 'network' };
    }
    if (!response.ok) return { ok: false, error: `http_${String(response.status)}` };
    try {
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) return { ok: false, error: 'unrecognised' };
      return { ok: true, answer: body as GatewayValidation & Record<string, unknown> };
    } catch {
      return { ok: false, error: 'unrecognised' };
    }
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * The gateway every test uses: it opens sessions on a made-up page and answers validations from
 * what the test planted (`validations`), as SSLCommerz would.
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly name = 'fake';
  readonly verified = true;
  readonly sessions: {
    readonly credentials: GatewayCredentials;
    readonly request: SessionRequest;
  }[] = [];
  /** By `val_id`: what the validation API should answer. */
  readonly validations = new Map<string, GatewayValidation & Record<string, unknown>>();
  failNextSession: string | null = null;

  openSession(credentials: GatewayCredentials, request: SessionRequest): Promise<SessionResult> {
    if (this.failNextSession !== null) {
      const error = this.failNextSession;
      this.failNextSession = null;
      return Promise.resolve({ ok: false, error });
    }
    this.sessions.push({ credentials, request });
    return Promise.resolve({
      ok: true,
      gatewayUrl: `https://sandbox.gateway.example/pay/${request.tranId}`,
      sessionKey: `session-${request.tranId}`,
    });
  }

  /** Validation ids the fake gateway does not answer for: a check still in flight (tests). */
  readonly unreachable = new Set<string>();

  validate(_credentials: GatewayCredentials, valId: string): Promise<ValidationResult> {
    if (this.unreachable.has(valId)) return Promise.resolve({ ok: false, error: 'unreachable' });
    const answer = this.validations.get(valId);
    return Promise.resolve(
      answer === undefined
        ? { ok: true, answer: { status: 'INVALID_TRANSACTION' } }
        : { ok: true, answer },
    );
  }
}
