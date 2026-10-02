/**
 * Where an SMS actually leaves the building (M16; D-012, §21).
 *
 * Separate from `@elysium/db`'s `SmsProvider`, which Better Auth calls for OTPs and which
 * returns `void`: the delivery log needs to know *how* a send went — accepted, refused
 * with a code a person can act on, or failed in a way worth retrying — and a `void` port
 * cannot say. Routing OTPs through this gateway as well is a follow-up (D-212).
 *
 * Every adapter is called **outside** a database transaction (invariant 6): the send job
 * reads the message in one transaction, calls the gateway with none open, and records
 * the outcome in another.
 */

export type SmsSendResult =
  | {
      readonly ok: true;
      /** The provider's own id for the message, when its documentation names one. */
      readonly providerMessageId: string | null;
    }
  | {
      readonly ok: false;
      /**
       * A short code for the log — the provider's own error number where it documents
       * one (`bulksmsbd:1007`), or `timeout` / `http_503` / `unrecognised_response`.
       * Never the provider's prose, which can echo the number back (invariant 10).
       */
      readonly error: string;
      /** Worth trying again later: a timeout or a 5xx, not "your balance is empty". */
      readonly retryable: boolean;
    };

export interface SmsGateway {
  readonly name: string;
  /** False: built from documentation and never seen to work against the real service. */
  readonly verified: boolean;
  /** False until its credentials are set. A misconfigured gateway refuses rather than guesses. */
  readonly configured: boolean;
  /**
   * Send one message.
   *
   * `phone` is national, `01XXXXXXXXX` — the form `notify.messages` stores. An adapter
   * that wants another form converts it itself, because only it knows what its API
   * expects.
   */
  send(
    phone: string,
    body: string,
    options: { readonly timeoutMs: number },
  ): Promise<SmsSendResult>;
}

export const SMS_GATEWAY = Symbol('SmsGateway');

/**
 * The gateway every test and every development run uses.
 *
 * It records instead of sending. It is also the deployment default: until somebody has
 * set a real gateway's credentials *and* opted into an unverified adapter, a message
 * sent from production goes here and nowhere else, which is the safe failure (D-012).
 */
export class FakeSmsGateway implements SmsGateway {
  readonly name = 'fake';
  readonly verified = true;
  readonly configured = true;
  readonly sent: { readonly phone: string; readonly body: string }[] = [];
  /** Set by a test to make the next sends fail, in order. */
  readonly failNext: SmsSendResult[] = [];

  send(phone: string, body: string): Promise<SmsSendResult> {
    const planned = this.failNext.shift();
    if (planned !== undefined) return Promise.resolve(planned);
    this.sent.push({ phone, body });
    return Promise.resolve({ ok: true, providerMessageId: `fake-${String(this.sent.length)}` });
  }

  clear(): void {
    this.sent.length = 0;
    this.failNext.length = 0;
  }
}
