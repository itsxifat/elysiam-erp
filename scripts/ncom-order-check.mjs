#!/usr/bin/env node
// The old website's ncom.bd order-intake checker (scripts/ncom-order-check.mjs, commit
// ee1358f), ported to the ERP on 2026-10-05 (M35b, D-556). Changes, each marked PORT: the
// signing helper is inlined; the order number is checked for being the ERP's own (any brand
// prefix, not the old site's); and a product of this shop is required, because an ERP order
// is made of the brand's own SKUs (D-556: an order of nothing the brand sells is refused).
//
// Conformance checker for the ncom.bd order intake at /api/ncom/orders.
//
//   node scripts/ncom-order-check.mjs \
//     --url http://localhost:3000/api/ncom/orders \
//     --key ncomord_… --secret ncomsec_…
//
// The sibling of ncom-check.mjs, for the other direction: that one proves ncom
// can READ this shop, this one proves ncom can WRITE an order into it. It signs
// exactly the way ncom does, so a signing change that would break the real
// integration breaks this too.
//
// UNLIKE ncom-check.mjs, THIS WRITES. It files a real order and takes real
// stock, then cleans both up. Point it at a development database.
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

const url = arg('url', process.env.NCOM_ORDER_URL);
const key = arg('key', process.env.NCOM_ORDER_KEY_ID);
const secret = arg('secret', process.env.NCOM_ORDER_SECRET);
const productId = arg('product');
const variantId = arg('variant');
const variantTitle = arg('size');

// PORT: a product and variant of this shop are required (D-556).
if (!url || !secret || !key || !productId || !variantId) {
  console.error(
    'usage: ncom-order-check.mjs --url <url> --key <keyId> --secret <secret> --product <id> --variant <id>',
  );
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** One request, signed the way ncom signs it. */
async function post(envelope, { sign = true, idempotencyKey } = {}) {
  const body = JSON.stringify(envelope);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'NCOM-Orders/1',
    'X-NCOM-Key': key,
    'X-NCOM-Contract': '1',
    'X-NCOM-Idempotency-Key': idempotencyKey ?? envelope.idempotencyKey,
  };
  if (sign) headers['X-NCOM-Signature'] = signatureHeader(secret, body);

  const response = await fetch(url, { method: 'POST', headers, body });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // PORT: lint. Not JSON: the checks that care report it.
  }
  return { status: response.status, json };
}

const stamp = Date.now().toString(36);

function envelope(topic, idempotencyKey, lines) {
  return {
    version: 1,
    topic,
    idempotencyKey,
    sentAt: new Date().toISOString(),
    organizationId: 'check',
    order: {
      id: idempotencyKey,
      orderNumber: `NCOM-${stamp}`,
      createdAt: new Date().toISOString(),
      currencyCode: 'BDT',
      customer: { name: 'Order Check', phone: '01799000000', email: null },
      shippingAddress: {
        name: 'Order Check',
        phone: '01799000000',
        email: null,
        address1: 'House 1, Road 1',
        address2: null,
        city: 'Dhaka',
        province: null,
        postalCode: null,
        countryCode: 'BD',
      },
      billingAddress: null,
      lines,
      subtotalCents: 200000,
      discountTotalCents: 50000,
      shippingTotalCents: 6000,
      taxTotalCents: 0,
      totalCents: 156000,
      discountCode: null,
      couponDiscountCents: 0,
      shippingMethodTitle: 'Inside Dhaka',
      paymentMethod: 'cash_on_delivery',
      status: 'pending',
      note: 'Placed by ncom-order-check',
      campaign: {
        pageId: 'p1',
        pageTitle: 'Check campaign',
        pageUrl: 'https://example.test/check',
        offerKey: 'check-offer',
        offerLabel: 'Buy 2, save ৳500',
        offerPriceCents: 150000,
        offerRegularCents: 200000,
      },
      store: {
        id: 's1',
        name: 'Check storefront',
        subdomain: 'check',
        url: 'https://check.ncom.bd',
      },
    },
  };
}

const ourLine =
  productId && variantId
    ? {
        productId,
        variantId,
        source: 'website',
        title: 'Checked product',
        variantTitle: variantTitle || null,
        sku: null,
        vendor: null,
        imageUrl: 'https://example.test/a.jpg',
        quantity: 1,
        unitPriceCents: 150000,
        discountCents: 50000,
        taxCents: 0,
        totalCents: 150000,
        requiresShipping: true,
        weightGrams: 500,
        isGift: false,
      }
    : null;

const foreignLine = {
  productId: 'ncom-product',
  variantId: 'ncom-variant',
  source: 'ncom',
  title: 'Gift stored in ncom',
  variantTitle: null,
  sku: null,
  vendor: null,
  imageUrl: 'https://example.test/gift.jpg',
  quantity: 1,
  unitPriceCents: 50000,
  discountCents: 50000,
  taxCents: 0,
  totalCents: 0,
  requiresShipping: true,
  weightGrams: 100,
  isGift: true,
};

const lines = ourLine ? [ourLine, foreignLine] : [foreignLine];

section('Nothing is trusted until the signature checks out');
{
  const unsigned = await post(envelope('order.placed', `unsigned_${stamp}`, lines), {
    sign: false,
  });
  check(unsigned.status === 401, `an unsigned handoff is refused (got ${unsigned.status})`);

  const body = JSON.stringify(envelope('order.placed', `tampered_${stamp}`, lines));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-NCOM-Key': key,
      'X-NCOM-Signature': signatureHeader(secret, body + ' '),
      'X-NCOM-Idempotency-Key': `tampered_${stamp}`,
    },
    body,
  });
  check(
    response.status === 401,
    `a signature over different bytes is refused (got ${response.status})`,
  );

  const wrongKey = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-NCOM-Key': 'ncomord_not_ours',
      'X-NCOM-Signature': signatureHeader(secret, body),
      'X-NCOM-Idempotency-Key': `wrongkey_${stamp}`,
    },
    body,
  });
  check(wrongKey.status === 401, `an unknown key id is refused (got ${wrongKey.status})`);
}

section('A test order is answered like a real one and filed like nothing');
{
  const test = await post(envelope('order.test', `test_${stamp}`, lines));
  check(test.status === 200, `answered 200 (got ${test.status})`);
  check(test.json?.test === true, 'reported as a test rather than as an order');
}

section('A real handoff becomes an ordinary order');
let placed;
{
  placed = await post(envelope('order.placed', `order_${stamp}`, lines));
  check(placed.status === 201, `answered 201 (got ${placed.status})`);
  check(Boolean(placed.json?.orderId), 'returned our own order id');
  check(
    // PORT: the ERP's own numbering, whatever the brand's prefix.
    /^[A-Z][A-Z0-9-]{2,}$/.test(placed.json?.orderNumber || ''),
    `numbered with our own sequence (got ${placed.json?.orderNumber})`,
  );
}

section('A retry after a timeout does not become a second order');
{
  const retry = await post(envelope('order.placed', `order_${stamp}`, lines));
  check(retry.status === 200, `a repeat is answered 200, not 409 (got ${retry.status})`);
  check(retry.json?.deduped === true, 'reported as a duplicate');
  check(
    retry.json?.orderId === placed.json?.orderId,
    'answered with the order we already have, not a new one',
  );
}

section('A malformed handoff is refused for good');
{
  const empty = await post({ ...envelope('order.placed', `empty_${stamp}`, []) });
  check(empty.status === 400, `an order with no lines is refused 400 (got ${empty.status})`);
}

console.log();
if (failures > 0) {
  console.log(`\x1b[31m${failures} check(s) failed\x1b[0m`);
  console.log(`\nOrder placed for cleanup: ${placed?.json?.orderNumber ?? '(none)'}`);
  process.exit(1);
}
console.log('\x1b[32mAll checks passed\x1b[0m');
console.log(`\nOrder placed for cleanup: ${placed?.json?.orderNumber ?? '(none)'}`);
