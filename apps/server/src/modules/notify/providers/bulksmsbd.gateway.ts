import type { SmsGateway, SmsSendResult } from './sms-gateway.js';

/**
 * BulkSMSBD (bulksmsbd.net), **UNVERIFIED** — built from its public developer page and
 * never seen to work against the real service (D-012, listed under unverified
 * integrations). Off unless `NOTIFY_SMS_PROVIDER=bulksmsbd` and
 * `NOTIFY_BULKSMSBD_ENABLED=true` are both set.
 *
 * ## What the page documents (bulksmsbd.com/bulksms-api-bangladesh.php, read 2026-10-01)
 *
 * - `.../api/smsapi`, "GET & POST", with `api_key`, `type=text`, `number`, `senderid` and
 *   `message`.
 * - `number` with the country code: `88017XXXXXXXX`.
 * - `202` means "SMS Submitted Successfully"; `1002`–`1021` are failures, each named.
 * - `1012`: "Masking SMS must be sent in Bengali".
 *
 * ## What it does not, and how this adapter treats each gap
 *
 * - **The response body's shape.** Only the code `202` is documented, not the field it
 *   arrives in. So success is a body that contains the token `202` and none of the
 *   documented failure codes, and anything else is a failure. No field name is invented,
 *   and no provider message id is recorded, because none is documented.
 * - **The scheme.** The page shows `http://`. Sending an API key over plain HTTP puts it
 *   on every hop between here and Dhaka, so this adapter defaults to `https://` on the
 *   same host and the base URL is configuration. Whether the host serves TLS is part of
 *   what verification has to establish.
 * - **Where POST reads its fields.** Sent as a form body rather than a query string, so
 *   the key is not written into proxy and access logs as part of a URL.
 * - **Bangla.** No `type` value for Unicode is documented; `type=text` is sent as shown.
 */

/** The failure codes the page lists, and whether trying later could help. */
const DOCUMENTED_FAILURES: Readonly<Record<string, boolean>> = {
  '1002': false, // sender id not correct / disabled
  '1003': false, // required fields missing
  '1005': true, // internal error
  '1006': false, // balance validity not available
  '1007': false, // balance insufficient
  '1011': false, // user id not found
  '1012': false, // masking SMS must be in Bengali
  '1013': false,
  '1014': false,
  '1015': false,
  '1016': false,
  '1017': false,
  '1018': false, // account disabled
  '1019': false,
  '1020': false,
  '1021': false,
};

export interface BulkSmsBdConfig {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly senderId: string | undefined;
}

export class BulkSmsBdGateway implements SmsGateway {
  readonly name = 'bulksmsbd';
  readonly verified = false;

  constructor(private readonly config: BulkSmsBdConfig) {}

  get configured(): boolean {
    return this.config.apiKey !== undefined && this.config.senderId !== undefined;
  }

  async send(
    phone: string,
    body: string,
    options: { readonly timeoutMs: number },
  ): Promise<SmsSendResult> {
    const { apiKey, senderId } = this.config;
    if (apiKey === undefined || senderId === undefined) {
      return { ok: false, error: 'unconfigured', retryable: false };
    }

    // `01711000999` becomes `8801711000999`: the country code without the plus.
    const form = new URLSearchParams({
      api_key: apiKey,
      type: 'text',
      number: `88${phone}`,
      senderid: senderId,
      message: body,
    });

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/api/smsapi`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, error: timedOut ? 'timeout' : 'network', retryable: true };
    }

    if (response.status >= 500) {
      return { ok: false, error: `http_${String(response.status)}`, retryable: true };
    }

    const text = await response.text().catch(() => '');
    return BulkSmsBdGateway.interpret(response.status, text);
  }

  /**
   * What a response means, from the only facts the page gives: `202` is success, and the
   * listed numbers are named failures. Public so the reading can be tested without a
   * network.
   */
  static interpret(status: number, text: string): SmsSendResult {
    const tokens = new Set(text.match(/\b\d{3,4}\b/g) ?? []);
    const failure = Object.keys(DOCUMENTED_FAILURES).find((code) => tokens.has(code));
    if (failure !== undefined) {
      return {
        ok: false,
        error: `bulksmsbd:${failure}`,
        retryable: DOCUMENTED_FAILURES[failure] ?? false,
      };
    }
    if (status >= 200 && status < 300 && tokens.has('202')) {
      return { ok: true, providerMessageId: null };
    }
    return { ok: false, error: 'unrecognised_response', retryable: false };
  }
}
