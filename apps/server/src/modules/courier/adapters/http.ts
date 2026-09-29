import { CourierError } from '../courier.errors.js';

/**
 * One outbound call to a courier, with the refusals every adapter maps the same way (M15).
 *
 * Steadfast's adapter has this inline (M12); Pathao and RedX share this copy so the two new
 * adapters cannot disagree about what a 429 means. The mapping is the part worth reading:
 *
 * - **no answer at all** (timeout, DNS, reset) is `COURIER_UNAVAILABLE`, retryable — §20's
 *   five attempts with backoff outlast a courier's restart;
 * - **401/403** is `COURIER_CREDENTIALS_MISSING`, not retryable — a revoked key does not come
 *   back, and five attempts against it is five chances to get the account rate-limited;
 * - **429 and 5xx** are `COURIER_UNAVAILABLE`, retryable;
 * - **any other 4xx** is `COURIER_BOOKING_FAILED`, not retryable — the request is wrong and
 *   sending it unchanged will be wrong again, so the job dead-letters now rather than in
 *   three minutes.
 *
 * **Nothing from the response body is ever put in an error message.** A courier's refusal
 * body echoes the recipient's name, phone and address we sent it, and an error message ends
 * up in `pgboss.job.output`, in logs and in `delivery.booking_failed` (invariant 10). The
 * caller gets the provider, the status and the code.
 *
 * The `authFailed` hook lets an adapter with a cached access token drop it and try once more
 * with a fresh one: a token revoked early is a normal event, and a booking that failed for
 * it would be a booking failed for nothing.
 */
export async function courierRequest(input: {
  readonly provider: string;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...input.headers,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    throw new CourierError(
      'COURIER_UNAVAILABLE',
      `${input.provider} did not answer (${error instanceof Error ? error.name : 'network error'}).`,
      true,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new CourierError(
      'COURIER_CREDENTIALS_MISSING',
      `${input.provider} rejected this account’s credentials.`,
      false,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new CourierError(
      'COURIER_UNAVAILABLE',
      `${input.provider} answered ${String(response.status)}.`,
      true,
    );
  }
  if (!response.ok) {
    throw new CourierError(
      'COURIER_BOOKING_FAILED',
      `${input.provider} refused this request (${String(response.status)}).`,
      false,
    );
  }

  try {
    return { status: response.status, body: await response.json() };
  } catch {
    throw new CourierError('COURIER_UNAVAILABLE', `${input.provider}’s answer was not JSON.`, true);
  }
}

/** A nested object, or null. Never throws: the body is somebody else's. */
export function objectAt(value: unknown, key: string | null): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (key === null) return value as Record<string, unknown>;
  const nested = (value as Record<string, unknown>)[key];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return null;
  return nested as Record<string, unknown>;
}

/**
 * A string field, accepting a number where a courier sends one.
 *
 * Coerced to a *string*: a consignment number is an identifier, and a seventeen-digit id
 * read as a JSON number has already lost its last digits.
 */
export function stringAt(row: Record<string, unknown> | null, key: string): string | null {
  if (row === null) return null;
  const value = row[key];
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A taka amount as poisha, as a decimal string, or null when absent or unreadable.
 *
 * Read from the field's *text*, never through a float: a number field is turned back into
 * its shortest decimal text by `String()` and parsed as digits, and anything with more than
 * two decimals is refused rather than rounded (invariant 1). Unreadable is null rather than
 * zero — "the courier did not say" and "the courier said nothing was collected" post
 * different journals.
 */
export function takaAtAsPoisha(row: Record<string, unknown> | null, key: string): string | null {
  const raw = stringAt(row, key);
  if (raw === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw.replace(/[৳,\s]/g, ''));
  if (match === null) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fraction = BigInt((match[3] ?? '').padEnd(2, '0'));
  return (sign * (whole * 100n + fraction)).toString();
}

/**
 * An instant from a courier's timestamp, or null.
 *
 * ISO 8601 with an offset is taken as written. A bare `YYYY-MM-DD HH:MM:SS` — the MySQL
 * datetime Bangladeshi couriers commonly send — carries no zone, and is read as Asia/Dhaka
 * wall time (+06:00, no daylight saving) because that is the only zone these couriers
 * operate in. Reading it as UTC would put every event six hours early, and an event at
 * 03:00 Dhaka on the 1st onto the previous business date (invariant 8).
 */
export function instantAt(row: Record<string, unknown> | null, key: string): Date | null {
  const raw = stringAt(row, key);
  if (raw === null) return null;
  const bare = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(raw);
  const at = bare === null ? new Date(raw) : new Date(`${bare[1] ?? ''}T${bare[2] ?? ''}+06:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A Bangladeshi mobile number in the local form every courier's rider app dials. */
export function localPhone(e164: string): string {
  return e164.replace(/^\+880/, '0');
}
