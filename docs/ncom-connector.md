# The ncom.bd connector (contract 1)

M35b, D-553 and D-556. ncom.bd builds landing pages and sells on them (D-550: the ERP builds
none). To do that it reads a brand's products and stock from the brand's ERP, holds stock while
a shopper checks out on one of its pages, and hands the order over. This page is what ncom
calls and what it gets back. It is the old website's connector (`/api/ncom/v1/*`, contract 1),
moved into the ERP with the same shapes, so ncom's side needs only new addresses.

The old site's own checkers pass against it: `scripts/ncom-check.mjs` (the connector) and
`scripts/ncom-order-check.mjs` (the order handover), run in
`apps/server/src/modules/marketplace/marketplace.e2e.test.ts`.

## Addresses

Each brand has its own, shown on **Website → Marketplace** (the org id is in the path, so a
request names its brand before anything is trusted, the way the SSLCommerz IPN does):

| What                  | Address                                  |
| --------------------- | ---------------------------------------- |
| Connector (reads)     | `<API_PUBLIC_URL>/ncom/<org id>/v1`      |
| Orders (handover)     | `<API_PUBLIC_URL>/ncom/<org id>/orders`  |
| Webhook (ncom events) | `<API_PUBLIC_URL>/ncom/<org id>/webhook` |

The old site's addresses were `https://<site>/api/ncom/v1`, `/api/ncom/orders` and
`/api/ncom/webhook`. A brand can either give ncom the new addresses above, or keep the old ones
by having the website's nginx rewrite them to the ERP with the brand's org id in the path
(`/api/ncom/v1/…` → `<ERP>/ncom/<org id>/v1/…`, and the same for `orders` and `webhook`; M37).
The rewrite must pass the body byte for byte: the signature is over the raw body.

Running the old checkers against a brand:

```
node scripts/ncom-check.mjs --url https://<erp host>/ncom/<org id>/v1 --key <connector key id> --secret <connector secret>
node scripts/ncom-order-check.mjs --url https://<erp host>/ncom/<org id>/orders --key <order key id> --secret <order secret> --product <id> --variant <id>
```

The order checker files real test orders: run it on a staging brand, never a live one.

## Signing

Every request in both directions is signed with HMAC-SHA256 over the raw body:

```
X-NCOM-Key: <key id>
X-NCOM-Contract: 1
X-NCOM-Signature: t=<unix seconds>,v1=<hex HMAC_SHA256(secret, "<t>." + rawBody)>
X-NCOM-Idempotency-Key: <key>            (order handovers and the ERP's updates)
```

- A GET signs the empty body.
- The timestamp must be within 300 seconds of the server's clock.
- The comparison is constant-time.
- The connector reads use the **connector** key id and secret; order handovers and the ERP's
  updates back to ncom use the **order** key id and secret; webhooks use the **webhook** secret.
  All are set on Website → Marketplace by an org admin (`update WebsiteCredentials`), sealed
  under `STOREFRONT_CREDENTIALS_KEY` and shown afterwards only as fingerprints. The ncom API
  key is kept for parity with the old site; contract 1 sends nothing with it.

Until the signature checks out, every refusal is the same `401` (a brand not set up for ncom
answers exactly like a wrong signature); after repeated failures from one address it carries
`Retry-After: 60`. Only then: a wrong `X-NCOM-Contract` is `400 unsupported_contract`, a
connector switched off answers `503 not_serving`, and an order to a shop not taking ncom's
orders `503`. The last refusal's reason (never the secret) is shown on the Marketplace screen.
Every answer has its cost fields stripped before it is written (invariant 5).

Raw bodies are capped at 256 KiB for the connector, 512 KiB for orders and 1 MiB for webhooks.

## Reads

All under the connector address, signed with the connector key.

### `GET /ping`

```json
{
  "ok": true,
  "contract": "1",
  "platform": "erp/1",
  "currency": "BDT",
  "capabilities": {
    "products": true,
    "stock": true,
    "search": true,
    "categories": true,
    "reserve": true,
    "release": true
  }
}
```

`search`, `categories` and `reserve`/`release` follow the switches on the Marketplace screen.

### `GET /products`

Query: `limit` (1 to 100, default 50), `cursor`, `status` (`active` | `draft`), `category` (id or handle;
its subcategories included), `q` (when search is allowed; otherwise `501`), or `ids=a,b,c` (or
repeated `ids`; up to 250, answered in the order asked, no paging).

```json
{
  "products": [
    {
      "id": "1042",
      "handle": "linen-panjabi",
      "title": "Linen Panjabi",
      "status": "active",
      "description": "",
      "vendor": "<the site's name>",
      "categoryId": "17",
      "url": "https://<site>/shop/linen-panjabi",
      "images": [{ "url": "https://<api>/media/<org>/<file>/full", "alt": "" }],
      "options": [{ "name": "Size", "values": ["M", "L"] }],
      "variants": [
        {
          "id": "5531",
          "title": "M",
          "sku": "LP-M",
          "price": "1290.00",
          "options": ["M"],
          "available": 4,
          "policy": "deny",
          "requiresShipping": true,
          "weightGrams": 250
        }
      ]
    }
  ],
  "nextCursor": "eyJpZCI6Ii4uLiJ9"
}
```

- **Ids.** A product, variant or category the old website knew keeps its old id (from
  `storefront.legacy_ids`); anything newer is its ERP uuid. Both are accepted wherever an id is
  read.
- **Status.** `active` is a product on the website (`web_visible`); `draft` is in the catalog but
  not on the website, offered only when "Include draft products" is on, so a page can be built
  before the product goes live. A draft's variants show `available: 0`. There is no `archived`.
- **Price** is the shelf price in taka with two decimals (`ncomPrice`), never a cost
  (invariant 5).
- **Available** is `Σ max(0, on_hand − reserved)` over the website's selling locations, read
  live.
- `weightGrams` is the Marketplace screen's default weight, when one is set.

### `GET /products/{id}`

One product by id (old or new) or handle: `{ "product": {...} }`, or `404`.

### `GET /categories`

```json
{
  "categories": [
    {
      "id": "17",
      "handle": "panjabi",
      "name": "Panjabi",
      "parentId": null,
      "position": 1,
      "url": "https://<site>/shop?category=panjabi"
    }
  ]
}
```

### `POST /stock`

Body `{ "ids": ["5531", "…"] }` (variant ids, up to 1,000; more is `422`). An unknown id
answers `available: 0`:

```json
{ "stock": [{ "id": "5531", "available": 4, "policy": "deny" }] }
```

## Holding stock

### `POST /reserve`

Body `{ "orderRef": "<ncom checkout id>", "lines": [{ "variantId": "5531", "quantity": 2 }] }`
(up to 100 lines). All or nothing, at one of the website's locations, with the inventory's
atomic conditional reserve (invariant 3):

- `{ "ok": true, "held": 1 }`: held.
- `{ "ok": true, "idempotent": true }`: this reference already holds its stock.
- `{ "ok": false, "rejected": [{ "variantId": "5531", "reason": "Sold out", "available": 1, "requested": 2 }] }`:
  nothing was held.

A reference that was released cannot hold again; ncom uses a new one.

### `POST /release`

Body `{ "orderRef": "…" }`. Gives back exactly what the hold took, once:
`{ "ok": true, "released": 2 }`, or `{ "ok": true, "released": 0, "noop": true }` for a
reference with nothing held.

A hold is not a sale. On the old site, holds and handed-over orders were two modes: while a
shop does not take ncom's orders, ncom holds through `/reserve` and keeps its orders; once the
shop takes them ("Take ncom's orders"), ncom stops holding and the order holds its own stock.
As a safety net, a hold becomes the order's stock when ncom hands over an order whose `id` or
`orderNumber` is the hold's reference. A hold ncom never releases stays on Website →
Marketplace, where an org admin releases it; nothing releases it on a timer (D-559).

## Order handover

`POST <orders address>`, signed with the order key, with `X-NCOM-Idempotency-Key`. Taken only
while "Take ncom's orders" is on (otherwise `503`).

```json
{
  "topic": "order.created",
  "idempotencyKey": "ncom:ord_9f2:1",
  "revision": 1,
  "order": {
    "id": "ord_9f2",
    "orderNumber": "NC-10422",
    "customer": { "name": "Rumana", "phone": "01712345678", "email": null },
    "shippingAddress": { "address1": "House 4, Road 2", "city": "Dhaka", "province": "Mirpur" },
    "lines": [
      {
        "productId": "1042",
        "variantId": "5531",
        "source": "website",
        "title": "Linen Panjabi",
        "variantTitle": "M",
        "sku": "LP-M",
        "quantity": 1,
        "unitPriceCents": 129000
      }
    ],
    "subtotalCents": 129000,
    "discountTotalCents": 0,
    "shippingTotalCents": 6000,
    "totalCents": 135000,
    "store": { "name": "…", "url": "…" },
    "campaign": {
      "pageTitle": "…",
      "pageUrl": "…",
      "offerKey": "…",
      "offerLabel": "…",
      "offerPriceCents": 119000,
      "offerRegularCents": 129000
    }
  }
}
```

- `order.test` answers `200 {"ok":true,"test":true}` and files nothing. Any topic other than
  `order.created`, `order.placed`, `order.updated`, `order.cancelled` (or none) is `400`.
- `order.created` (or `order.placed`) files an order on the `marketplace` channel, `pending`,
  created by `marketplace:ncom`: `201 {"ok":true,"orderId":"…","orderNumber":"…"}`. The same
  ncom order or idempotency key again answers `200` with `"deduped": true`. A refusal of the
  ERP's order rules (a line it cannot take) is `422` with the reason: final, not retried.
- **Money** (`ncomOrderMoney`). ncom's minor units are poisha. `totalCents` and
  `shippingTotalCents` must be whole numbers, every line needs a quantity from 1 to 10,000 and a
  `unitPriceCents` or `totalCents`, and the figures must add up one of two ways: the lines'
  `totalCents` plus shipping (less any `couponDiscountCents`) is the total, or units times
  quantities plus shipping less `discountTotalCents` is. Anything else is `400`, and so is a
  non-zero `taxTotalCents` (an order of this shop has no tax to put it in). The discount falls
  on the goods first, split between the brand's lines and other shops' lines by value; the
  brand collects its own goods less their share plus the delivery. Lines from other shops are
  kept beside the order as "foreign items" with their value less their share, never sold or
  collected here.
- **Address.** ncom's free text is matched to a district and thana (`matchDistrict`,
  `matchThana`); what cannot be matched is kept as text with a warning on the order.
- **Stock.** A matching hold becomes the order's stock; with none, the order is filed and its
  stock is taken when it is confirmed, like any order.
- `order.updated` and `order.cancelled` carry `baseRevision` (the revision ncom last saw) and
  `revision`. A stale base is `409 {"error":"This shop holds a different version of the order","revision":n}`.
  An edit goes through the order desk's own edit; a cancel through the state machine
  (invariant 7). An edit or cancel the order can no longer take (it is packed or shipped), an
  edit naming a product of the brand that no longer resolves or leaving none of its lines, and
  one that would not collect the brand's part of the new total are `409` with the revision and
  a warning on the order for a person to act on; nothing of them is applied.

## Updates back to ncom

When a handed-over order moves (confirmed, packed, shipped, delivered, returned, cancelled), or
a person edits it at the desk, the ERP queues an update in `marketplace.ncom_outbox` with a new
revision, from the change's own event, and the worker sends it with no transaction open
(invariant 6). Redirects are not followed:

```
POST <ncom's address>/api/orders/callback
X-NCOM-Key: <order key id>
X-NCOM-Contract: 1
X-NCOM-Idempotency-Key: erp:<order id>:<revision>
X-NCOM-Signature: t=…,v1=…        (the order secret)

{ "version": 1, "topic": "order.updated", "idempotencyKey": "erp:<order id>:<revision>",
  "sentAt": "…", "baseRevision": 3, "revision": 4, "reason": null,
  "order": { "id": "ord_9f2", "orderNumber": "<the ERP's number>", "status": "shipped",
             "fulfilmentStatus": "shipped", "paymentStatus": "pending", "currencyCode": "BDT",
             "subtotalCents": 129000, "discountTotalCents": 0, "shippingTotalCents": 6000,
             "taxTotalCents": 0, "totalCents": 135000, "shippingAddress": {…}, "lines": [ … ] } }
```

- `status` is one of `pending`, `processing`, `shipped`, `delivered`, `cancelled`
  (`ncomStatusFor`); `fulfilmentStatus` is the ERP's own status.
- A change ncom made itself is not echoed back.
- Delivery: a 2xx is delivered; `409` or another 4xx (but 408 and 429) is refused and final;
  anything else is retried after 15 s, 1 min, 5 min, 15 min, 1 h, 3 h and 6 h, and fails after
  eight tries. The address must be `https`. The payload is sealed until it is sent. The
  Marketplace screen shows every update's state.

## Webhooks

`POST <webhook address>`, signed with the webhook secret, body `{ "id", "topic", "data" }`.
Each event id is taken once. `order.held_for_review`, `order.cancelled` and `shipment.returned`
for a handed-over order add a warning to it for a person to read; nothing moves stock or the
order by itself.
