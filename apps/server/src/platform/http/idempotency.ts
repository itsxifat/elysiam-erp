import { createHash } from 'node:crypto';

/**
 * The `Idempotency-Key` rules, as pure functions (architecture §23).
 *
 * Separated from the interceptor and the store so the two decisions that are
 * easy to get subtly wrong — is this key usable, and are these two requests the
 * same request — are testable without a database or a Nest context.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Set on a replayed response.
 *
 * Without it a client cannot distinguish "your second tap also worked" from
 * "your second tap created a second order", which is the only question it
 * actually has. Operations needs it too: a replay rate that suddenly climbs is
 * how a flapping connection at a showroom announces itself.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

/** §23: kept for 24 hours per user and route. */
export const IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * Methods that get a record.
 *
 * A GET has nothing to replay — it has no effect to avoid repeating — and
 * caching one would turn this table into a response cache with no invalidation,
 * which is a much worse thing than it looks. A client that sends the header on
 * a GET is not refused, it is simply not cached.
 */
const MUTATIONS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function isMutation(method: string): boolean {
  return MUTATIONS.includes(method.toUpperCase());
}

/**
 * Bounds on the key.
 *
 * Long enough that a client cannot pick one by accident: an 8-character floor
 * rules out `1`, `retry` and the incrementing integers that a hurried frontend
 * reaches for, any of which would collide across users the moment two people
 * submit at once — and the record is scoped per user, so the collision would be
 * between one person's *own* two different submissions. Short enough that the
 * unique index stays an index: 255 bytes, which also stops a caller writing a
 * megabyte into a column that is part of a btree.
 */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 255;

/**
 * Printable ASCII only.
 *
 * The key goes into a unique index and into log lines. A control character or a
 * newline in it would split a log line in two — the oldest log-injection trick
 * there is — and Unicode would let two visually identical keys be different
 * rows, so a client that normalises its UUIDs differently between builds would
 * silently stop deduplicating.
 */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

export type KeyCheck =
  { readonly ok: true; readonly key: string } | { readonly ok: false; readonly why: string };

export function checkKey(raw: unknown): KeyCheck {
  if (typeof raw !== 'string') {
    return { ok: false, why: 'Idempotency-Key must be sent once, as a single header.' };
  }
  const key = raw.trim();
  if (key.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      why: `Idempotency-Key must be at least ${String(MIN_KEY_LENGTH)} characters.`,
    };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return {
      ok: false,
      why: `Idempotency-Key must be at most ${String(MAX_KEY_LENGTH)} characters.`,
    };
  }
  if (!KEY_SHAPE.test(key)) {
    return { ok: false, why: 'Idempotency-Key must be printable ASCII with no spaces.' };
  }
  return { ok: true, key };
}

/**
 * A stable JSON rendering: object keys sorted, everything else left alone.
 *
 * The fingerprint has to answer "is this the same request", and `JSON.stringify`
 * answers "was this object built in the same order". Those differ in practice:
 * React Hook Form emits fields in declaration order, a manual retry rebuilds the
 * object from state in a different order, and the retry would then look like a
 * *different* request with the same key — which is reported to the operator as
 * `IDEMPOTENCY_CONFLICT` on a payment they are simply trying to resend.
 *
 * Arrays keep their order, because in a request body order is meaning: two
 * order lines swapped are the same order, but two journal lines swapped are not
 * something this layer may assume.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members vanish under JSON.stringify, so they must not be part
    // of the fingerprint either, or a body that round-trips through JSON would
    // fingerprint differently before and after.
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/**
 * What makes two requests "the same".
 *
 * Method, concrete path and body. The path is included as well as the route
 * template because `PUT /v1/orders/:id` with two different ids is two different
 * requests, and the record is keyed by the template — without the path in the
 * fingerprint, reusing one key across two ids would replay the first order's
 * response as if it were the second's.
 *
 * Hashed rather than stored whole: bodies contain customer addresses and phone
 * numbers, and this row outlives the request by a day (invariant 10). A hash
 * answers the only question asked of it.
 */
export function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

/** `POST /v1/ledger/cash-in` — the route template, never the concrete path. */
export function routeOf(method: string, template: string): string {
  return `${method.toUpperCase()} ${template}`;
}
