/**
 * The route-matrix suite's calls for M16's notify routes.
 *
 * Every fixture is a thunk, evaluated once per role, so nothing reads state at import
 * time — the shape `pos.route-fixtures.ts` established. The suite's question is which
 * roles the *guard* admits, not whether each call succeeds.
 *
 * Every write here is idempotent, which is what lets one fixed value serve every admitted
 * role without the second one answering 409:
 *
 * - `PUT /v1/notify/templates` upserts on `(org, key, channel)`;
 * - `POST /v1/notify/opt-outs` inserts with `on conflict do nothing`;
 * - `DELETE /v1/notify/opt-outs/:phone` removes a number that may already be gone.
 *
 * The phone is a test value for this suite, not anybody's (invariant 10).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const MATRIX_PHONE = '01700000099';

export const NOTIFY_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/notify/templates': () => ({ url: '/v1/notify/templates' }),
  'PUT /v1/notify/templates': () => ({
    url: '/v1/notify/templates',
    body: {
      key: 'matrix.probe',
      category: 'transactional',
      bodyBn: 'আপনার অর্ডার {order} পাঠানো হয়েছে।',
      bodyEn: 'Your order {order} is on its way.',
    },
  }),
  'GET /v1/notify/opt-outs': () => ({ url: '/v1/notify/opt-outs' }),
  'POST /v1/notify/opt-outs': () => ({
    url: '/v1/notify/opt-outs',
    body: { phone: MATRIX_PHONE, reason: 'route matrix' },
  }),
  'DELETE /v1/notify/opt-outs/:phone': () => ({ url: `/v1/notify/opt-outs/${MATRIX_PHONE}` }),
  'GET /v1/notify/messages': () => ({ url: '/v1/notify/messages' }),
};

export const NOTIFY_ROUTE_KEYS: readonly string[] = Object.keys(NOTIFY_ROUTE_FIXTURES);
