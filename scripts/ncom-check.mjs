#!/usr/bin/env node
// The old website's ncom.bd conformance checker (scripts/ncom-check.mjs, commit ee1358f),
// ported to the ERP on 2026-10-05 (M35b, D-553). Changes, each marked PORT: the signing
// helper is inlined (the old one lived in the website's lib/) and the usage text names the
// ERP's address. M35's acceptance check 4 runs it against the ERP's connector
// (apps/server/src/modules/marketplace/marketplace.e2e.test.ts).
//
// Conformance checker for an ncom.bd product source — ours or anyone's.
//
//   node scripts/ncom-check.mjs \
//     --url https://<erp host>/ncom/<org id>/v1 (PORT) \
//     --key ncomcat_… --secret ncomsec_…
//
// The same checks the admin panel runs at /admin/ncom → "Run self-test", minus
// the database, so it works from any machine that can reach the URL — which is
// the point: it proves the endpoint is reachable and correct from OUTSIDE the
// server it runs on. That is what ncom will be doing.
//
// Nothing here writes. The /reserve check asks for an impossible quantity,
// which must be refused; if it somehow is not, the hold is released again.
// PORT: the old site's lib/ncom-signature.js signatureHeader, inlined.
import { createHmac } from 'node:crypto';

function signatureHeader(secret, rawBody = '', timestamp = Math.floor(Date.now() / 1000)) {
  const prefix = Buffer.from(`${timestamp}.`, 'utf8');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const v1 = createHmac('sha256', secret)
    .update(Buffer.concat([prefix, body]))
    .digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
};

const url = arg('url', process.env.NCOM_CONNECTOR_URL).replace(/\/+$/, '');
const key = arg('key', process.env.NCOM_CONNECTOR_KEY);
const secret = arg('secret', process.env.NCOM_CONNECTOR_SECRET);

if (!url || !secret) {
  console.error(`
Usage: node scripts/ncom-check.mjs --url <base> --key <key id> --secret <secret>

  --url     the connector base, e.g. https://<erp host>/ncom/<org id>/v1 (PORT)
  --key     the key id ncom issued  (X-NCOM-Key)
  --secret  the signing secret ncom issued

Or set NCOM_CONNECTOR_URL / NCOM_CONNECTOR_KEY / NCOM_CONNECTOR_SECRET.
`);
  process.exit(1);
}

const C = {
  pass: (s) => `\x1b[32m${s}\x1b[0m`,
  fail: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let failed = 0;
let warned = 0;
function report(status, label, detail = '') {
  if (status === 'fail') failed++;
  if (status === 'warn') warned++;
  const tag = {
    pass: C.pass('PASS'),
    fail: C.fail('FAIL'),
    warn: C.warn('WARN'),
    skip: C.dim('SKIP'),
  }[status];
  console.log(`${tag}  ${label}${detail ? C.dim(`  — ${detail}`) : ''}`);
}

async function call(path, { method = 'GET', body = null, signature, keyId } = {}) {
  const raw = body === null ? '' : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url + path, {
      method,
      headers: {
        'X-NCOM-Key': keyId === undefined ? key : keyId,
        'X-NCOM-Contract': '1',
        'X-NCOM-Timestamp': String(timestamp),
        'X-NCOM-Signature':
          signature === undefined ? signatureHeader(secret, raw, timestamp) : signature,
        'User-Agent': 'NCOM-Catalog/1 (conformance check)',
        ...(body === null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === null ? undefined : raw,
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* reported as "not JSON" by whichever check cares */
    }
    return { status: res.status, json, text };
  } catch (e) {
    return {
      status: 0,
      json: null,
      text: '',
      error: e.name === 'AbortError' ? 'timed out' : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\nChecking ${url}\n`);

if (!/^https:\/\//i.test(url)) report('warn', 'Base URL is HTTPS', 'ncom refuses plain http://');

// ── handshake ───────────────────────────────────────────────────────────────
const ping = await call('/ping');
if (ping.status === 0) {
  report('fail', 'GET /ping reachable', ping.error);
  process.exit(1);
}
if (!ping.json) {
  report(
    'fail',
    'GET /ping returns JSON',
    `HTTP ${ping.status} with an HTML body — that is a web page, not a connector`,
  );
  process.exit(1);
}
report(
  ping.status === 200 && ping.json.ok ? 'pass' : 'fail',
  'GET /ping handshake',
  ping.status === 200
    ? `${ping.json.platform} · contract ${ping.json.contract} · ${ping.json.currency}`
    : `HTTP ${ping.status} — ${ping.json?.error?.message || ''}`,
);

const caps = ping.json.capabilities || {};
console.log(
  C.dim(
    `      capabilities: ${Object.entries(caps)
      .map(([k, v]) => `${v ? '' : 'no-'}${k}`)
      .join(' ')}`,
  ),
);

// ── authentication ──────────────────────────────────────────────────────────
report(
  (await call('/ping', { signature: '' })).status === 401 ? 'pass' : 'fail',
  'Unsigned request refused',
);
report(
  (await call('/ping', { signature: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` }))
    .status === 401
    ? 'pass'
    : 'fail',
  'Wrong signature refused',
);
report(
  (
    await call('/ping', {
      signature: signatureHeader(secret, '', Math.floor(Date.now() / 1000) - 3600),
    })
  ).status === 401
    ? 'pass'
    : 'fail',
  'Replayed (stale) request refused',
);
if (key)
  report(
    (await call('/ping', { keyId: 'ncomcat_wrong' })).status === 401 ? 'pass' : 'warn',
    'Foreign key id refused',
  );

// ── products ────────────────────────────────────────────────────────────────
const list = await call('/products?limit=3');
const products = list.json?.products;
if (!Array.isArray(products)) {
  report('fail', 'GET /products', `HTTP ${list.status} — no products array`);
  process.exit(1);
}
report(
  'pass',
  'GET /products',
  `${products.length} returned${list.json.total != null ? ` of ${list.json.total}` : ''}`,
);

const sample = products[0];
if (!sample) {
  report('warn', 'Product shape', 'nothing published to inspect');
} else {
  const missing = ['id', 'title', 'status', 'variants'].filter((k) => sample[k] === undefined);
  report(
    missing.length ? 'fail' : 'pass',
    'Product shape',
    missing.length ? `missing ${missing.join(', ')}` : sample.title,
  );

  const target = products[products.length - 1];
  const byIds = await call(`/products?ids=${encodeURIComponent(target.id)}`);
  const got = byIds.json?.products || [];
  report(
    got.length === 1 && got[0].id === target.id ? 'pass' : 'fail',
    '?ids= is honoured',
    got.length === 1
      ? ''
      : `asked for 1, got ${got.length} — saved offers would resolve to the wrong products`,
  );

  const one = await call(`/products/${encodeURIComponent(target.id)}`);
  report(
    one.status === 200 ? 'pass' : 'fail',
    'GET /products/{id}',
    one.status === 200 ? '' : `HTTP ${one.status}`,
  );

  const ghost = await call('/products/definitely-not-a-real-product');
  report(
    ghost.status === 404 ? 'pass' : 'fail',
    'A missing product answers 404',
    ghost.status === 404 ? '' : `answered ${ghost.status}`,
  );

  const variant = (sample.variants || [])[0];
  if (variant && caps.stock) {
    const stock = await call('/stock', { method: 'POST', body: { ids: [variant.id] } });
    const row = (stock.json?.stock || [])[0];
    report(
      row ? 'pass' : 'fail',
      'POST /stock',
      row
        ? `${variant.sku || variant.id} → ${row.available} (${row.policy})`
        : `HTTP ${stock.status}`,
    );
  }

  if (variant && caps.reserve) {
    const orderRef = `conformance-${Date.now()}`;
    const impossible = await call('/reserve', {
      method: 'POST',
      body: { orderRef, lines: [{ variantId: variant.id, quantity: 1_000_000 }] },
    });
    const refused = impossible.status === 200 && impossible.json?.ok === false;
    report(
      refused ? 'pass' : 'fail',
      'POST /reserve refuses an impossible quantity',
      refused
        ? impossible.json.rejected?.[0]?.reason || ''
        : `HTTP ${impossible.status} ok=${impossible.json?.ok}`,
    );
    if (impossible.json?.ok === true) {
      await call('/release', { method: 'POST', body: { orderRef } });
      console.log(C.warn('      the reservation was accepted and has been released again'));
    }
  } else {
    report(
      'skip',
      'POST /reserve',
      caps.reserve ? 'no variant to test with' : 'not declared in capabilities',
    );
  }
}

if (caps.categories) {
  const cats = await call('/categories');
  report(
    Array.isArray(cats.json?.categories) ? 'pass' : 'fail',
    'GET /categories',
    Array.isArray(cats.json?.categories)
      ? `${cats.json.categories.length} categor(ies)`
      : `HTTP ${cats.status}`,
  );
} else {
  report('skip', 'GET /categories', 'not declared in capabilities');
}

const typo = await call('/prodcuts');
report(
  typo.status === 404 && typo.json ? 'pass' : 'warn',
  'A mistyped path answers JSON, not HTML',
);

console.log(
  failed
    ? C.fail(`\n${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ''}.\n`)
    : warned
      ? C.warn(`\nAll essential checks passed, with ${warned} warning(s).\n`)
      : C.pass('\nEvery check passed.\n'),
);
process.exit(failed ? 1 : 0);
