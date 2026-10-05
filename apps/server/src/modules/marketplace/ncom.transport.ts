import { Injectable } from '@nestjs/common';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** What one call to ncom came back with: a status, or none, and a little of the body. */
export interface NcomAnswer {
  readonly status: number | null;
  readonly text: string;
  /** Why there was no answer; empty when there was one. */
  readonly error: string;
}

/**
 * The one outbound call the marketplace makes: a change of an order back to ncom (M35b, D-556),
 * from the worker with no transaction open (invariant 6). The URL holds nothing secret (the key
 * id and the signature are headers), and a failure never carries the body.
 *
 * `fetchImpl` is a field so a test can stand a stub in for ncom; nothing else changes it.
 */
@Injectable()
export class NcomTransport {
  fetchImpl: Fetch = (url, init) => fetch(url, init);
  timeoutMs = 15_000;

  async post(
    url: string,
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<NcomAnswer> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { ...headers },
        body,
        // A redirect is not followed: the signed order goes to the address the org admin set
        // and nowhere it is pointed on to (the ledger audit's note 4). A 3xx is an answer.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text().catch(() => '');
      return { status: response.status, text: text.slice(0, 500), error: '' };
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      return { status: null, text: '', error: timedOut ? 'timed out' : 'unreachable' };
    }
  }
}
