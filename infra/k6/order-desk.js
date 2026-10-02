/**
 * k6: the order desk's API under load (M30, architecture §29).
 *
 * Run by `scripts/load-test.mjs` inside the `grafana/k6` image, never by hand against a
 * shared database: the runner provisions a throwaway stack, signs the agents in and writes
 * `run.json` (sessions, SKUs, buyers) into the mounted work directory.
 *
 * The desk's calls, each at its own constant arrival rate, so every call gets enough
 * samples for a p95 regardless of how slow the others are:
 *
 *   lookup        GET  /v1/customers/lookup?phone=   §29: p95 < 300 ms (the fraud badge
 *                                                     half of that row was removed, D-291)
 *   sku_search    GET  /v1/catalog/skus?q=&limit=12  §29: p95 < 200 ms on 20k SKUs
 *   order_save    POST /v1/orders                    §29: p95 < 400 ms
 *   availability  GET  /v1/orders/availability       no §29 row; reported
 *   queue         GET  /v1/orders?limit=25           no §29 row; reported
 *
 * A warm-up phase runs first at a lower rate and is excluded from the thresholds by its
 * `phase` tag: the first requests pay for connection pools and JIT, which a desk that has
 * been open all morning does not.
 */

import http from 'k6/http';
import { check } from 'k6';

const data = JSON.parse(open('/work/run.json'));

const WARMUP = __ENV.WARMUP ?? '15s';
const DURATION = __ENV.DURATION ?? '60s';
const SCALE = Number(__ENV.SCALE ?? '1');

/** Per-second arrival rates for the measured phase, before SCALE. */
const RATES = { lookup: 10, sku_search: 10, order_save: 5, availability: 5, queue: 2 };

/** §29's budgets, in ms. The calls with no row get a loose ceiling so they appear in the summary. */
const BUDGETS = { lookup: 300, sku_search: 200, order_save: 400, availability: 1000, queue: 1000 };

function scenarios() {
  const out = {};
  for (const [op, rate] of Object.entries(RATES)) {
    const base = {
      executor: 'constant-arrival-rate',
      timeUnit: '1s',
      preAllocatedVUs: Math.max(5, rate * SCALE * 2),
      maxVUs: Math.max(20, rate * SCALE * 10),
      exec: op,
    };
    out[`${op}_warmup`] = {
      ...base,
      rate: Math.max(1, Math.round((rate * SCALE) / 2)),
      duration: WARMUP,
      tags: { phase: 'warmup' },
    };
    out[op] = {
      ...base,
      rate: Math.max(1, Math.round(rate * SCALE)),
      duration: DURATION,
      startTime: WARMUP,
      tags: { phase: 'measure' },
    };
  }
  return out;
}

function thresholds() {
  const out = {};
  for (const [op, budget] of Object.entries(BUDGETS)) {
    out[`http_req_duration{op:${op},phase:measure}`] = [`p(95)<${String(budget)}`];
    out[`http_req_failed{op:${op},phase:measure}`] = ['rate<0.01'];
  }
  return out;
}

export const options = {
  scenarios: scenarios(),
  thresholds: thresholds(),
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  // Thresholds are the report's verdict, not a reason to stop: a slow call still gets its
  // numbers recorded.
  noConnectionReuse: false,
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function session() {
  // One of the four agents, by VU, so the server sees four sessions rather than one.
  return data.sessions[(__VU - 1) % data.sessions.length];
}

function headers(op, mutation) {
  const s = session();
  const out = { cookie: s.cookie, origin: data.origin, accept: 'application/json' };
  if (mutation) {
    out['content-type'] = 'application/json';
    out['x-elysium-csrf'] = s.csrf;
    out['idempotency-key'] = `${op}-${String(__VU)}-${String(__ITER)}-${String(Date.now())}`;
  }
  return out;
}

const params = (op, mutation = false) => ({ headers: headers(op, mutation), tags: { op } });

function existingPhone() {
  const n = 1 + Math.floor(Math.random() * data.customers);
  return `${data.phonePrefix}${String(n).padStart(6, '0')}`;
}

function newPhone() {
  // +88019 and eight digits: never one of the seeded +8801711 buyers.
  return `+88019${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
}

export function lookup() {
  // Four in five lookups are a buyer the brand already has, as at a real desk.
  const phone = Math.random() < 0.8 ? existingPhone() : newPhone();
  const response = http.get(
    `${data.apiUrl}/v1/customers/lookup?phone=${encodeURIComponent(phone)}`,
    params('lookup'),
  );
  check(response, { 'lookup 200': (r) => r.status === 200 });
}

const FRAGMENTS = ['panjabi', 'kurta silk', 'saree', 'cotton', 'jeans', 'hijab', 'kameez'];

export function sku_search() {
  // A code fragment as an agent types it, or a word from a product name.
  const q =
    Math.random() < 0.5
      ? `LD-${String(1 + Math.floor(Math.random() * 1999)).padStart(4, '0')}`
      : pick(FRAGMENTS);
  const response = http.get(
    `${data.apiUrl}/v1/catalog/skus?q=${encodeURIComponent(q)}&limit=12`,
    params('sku_search'),
  );
  check(response, { 'sku search 200': (r) => r.status === 200 });
}

export function availability() {
  const ids = [pick(data.skus).id, pick(data.skus).id, pick(data.skus).id];
  const response = http.get(
    `${data.apiUrl}/v1/orders/availability?skuIds=${[...new Set(ids)].join(',')}`,
    params('availability'),
  );
  check(response, { 'availability 200': (r) => r.status === 200 });
}

export function queue() {
  const response = http.get(`${data.apiUrl}/v1/orders?limit=25`, params('queue'));
  check(response, { 'queue 200': (r) => r.status === 200 });
}

export function order_save() {
  const count = 1 + Math.floor(Math.random() * 3);
  const chosen = new Map();
  while (chosen.size < count) {
    const sku = pick(data.skus);
    chosen.set(sku.id, { skuId: sku.id, qty: 1 });
  }
  const body = {
    channel: 'facebook',
    customer: {
      // Half are returning buyers (their number is already on file), half are new.
      phone: Math.random() < 0.5 ? existingPhone() : newPhone(),
      name: 'Load Test Buyer',
      address: {
        districtId: data.area.districtId,
        thanaId: data.area.thanaId,
        addressLine: 'House 7, Road 3, Savar',
      },
    },
    locationId: data.locationId,
    lines: [...chosen.values()],
  };
  const response = http.post(
    `${data.apiUrl}/v1/orders`,
    JSON.stringify(body),
    params('order_save', true),
  );
  check(response, { 'order save 201': (r) => r.status === 201 });
}
