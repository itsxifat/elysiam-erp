/**
 * k6: the public order intake at §29's rate (M30).
 *
 * §29: "Public intake API — p95 < 500 ms at 20 req/s sustained". Every request is a new,
 * correctly signed order (docs/public-api.md): a fresh idempotency key, a fresh buyer phone
 * and a fresh visitor IP, signed with the site key the runner issued through
 * `POST /v1/intake/site-keys`. Run by `scripts/load-test.mjs` inside `grafana/k6`.
 *
 * What the local number leaves out, and the report says so: Turnstile's siteverify round
 * trip to Cloudflare. The runner points the API at a local stub that answers at once, so the
 * real client and its HTTP call are exercised but the network to Cloudflare is not.
 */

import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

const data = JSON.parse(open('/work/run.json'));

const WARMUP = __ENV.WARMUP ?? '15s';
const DURATION = __ENV.DURATION ?? '60s';
const RATE = Number(__ENV.RATE ?? '20');

const base = {
  executor: 'constant-arrival-rate',
  timeUnit: '1s',
  preAllocatedVUs: RATE * 2,
  maxVUs: RATE * 10,
  exec: 'post_order',
};

export const options = {
  scenarios: {
    warmup: { ...base, rate: Math.max(1, RATE / 4), duration: WARMUP, tags: { phase: 'warmup' } },
    sustained: {
      ...base,
      rate: RATE,
      duration: DURATION,
      startTime: WARMUP,
      tags: { phase: 'measure' },
    },
  },
  thresholds: {
    'http_req_duration{op:intake,phase:measure}': ['p(95)<500'],
    'http_req_failed{op:intake,phase:measure}': ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const octet = () => String(1 + Math.floor(Math.random() * 254));

export function post_order() {
  const lines = [{ skuCode: pick(data.skus).code, qty: 1 }];
  const second = pick(data.skus).code;
  if (Math.random() < 0.3 && second !== lines[0].skuCode) lines.push({ skuCode: second, qty: 1 });

  const body = JSON.stringify({
    customer: {
      name: 'Intake Load Buyer',
      // A local spelling, as a form sends it: 013 and eight digits.
      phone: `013${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`,
    },
    address: {
      districtId: data.area.districtId,
      thanaId: data.area.thanaId,
      addressLine: 'House 4, Road 2, Savar',
    },
    lines,
    utm: { source: 'facebook', medium: 'cpc', campaign: 'load-test' },
    turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
    visitor: { ip: `198.18.${octet()}.${octet()}` },
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = `load-${String(__VU)}-${String(__ITER)}-${String(Date.now())}`;
  const signature = crypto.hmac('sha256', data.intake.secret, `${timestamp}.${key}.${body}`, 'hex');

  const response = http.post(`${data.apiUrl}/public/v1/orders`, body, {
    headers: {
      'content-type': 'application/json',
      'x-api-key': data.intake.keyId,
      'x-api-timestamp': timestamp,
      'x-api-signature': `sha256=${signature}`,
      'idempotency-key': key,
    },
    tags: { op: 'intake' },
  });
  check(response, { 'intake 201': (r) => r.status === 201 });
}
