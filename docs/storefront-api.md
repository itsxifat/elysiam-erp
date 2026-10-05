# Storefront API

For the developers of a brand's own website (M36 converts the first one). The website has no
database of its own: its **server** reads the catalog, the categories, the menu and the site's
settings from the brand's ERP through this API, signed with a website key. Shoppers' browsers
never call it; they get the website's pages and the public images under `/media/`.

Built in M33 (architecture §31, decisions D-500 to D-512). M34 adds the checkout, accounts and
payments under the same prefix and the same keys; M35 adds flash sales, landing pages and
custom links.

## At a glance

| What            | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| Base            | `https://<api host>/storefront/v1`                                                     |
| Methods         | `GET` (M33); `POST` and `PATCH` for buying and accounts (M34)                          |
| Authentication  | A website key id plus an HMAC-SHA256 signature over the timestamp, method, path, query |
| Clock tolerance | ±5 minutes                                                                             |
| Success         | `200` JSON, or `304` with no body for a matching `If-None-Match`                       |
| Caching         | `ETag`, `Cache-Control: private, max-age=30, stale-while-revalidate=300`               |
| Money           | Every amount is `{ "poisha": "125000", "taka": "1250.00" }`: integer poisha and taka   |
| Errors          | RFC 9457 `application/problem+json` with a stable `code`                               |

## Getting a key

An org admin or a marketing user issues a key on **Website → Connection** in the ERP console
(`POST /v1/storefront/site-keys` with a label). The answer carries:

- `keyId`: `pk_…`. Public. Sent on every request.
- `secret`: `sk_…`. **Shown once and never again.** Keep it in the website server's secret
  store (for example `ERP_SITE_SECRET`). Lost, it is a revoked key and a new one.

A website key is not a landing-page order key (`/public/v1/orders`, `docs/public-api.md`): the
two are issued in different places, derive different secrets and are refused by each other's
endpoints. Revoking a key on Website → Connection stops it at once.

## Signing a request

Three headers on every request:

| Header            | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| `X-Api-Key`       | The key id, `pk_…`                                       |
| `X-Api-Timestamp` | Unix seconds, decimal digits only (`1780000000`)         |
| `X-Api-Signature` | `sha256=` and the lower-case hex HMAC-SHA256 shown below |

What is signed, for a `GET`, is the timestamp, the method and the request target **exactly as
it is sent** — the path and the query string, not re-encoded, not sorted:

```
<timestamp>.GET./storefront/v1/catalog/products?category=menswear&sort=newest
```

A `POST` or `PATCH` (M34) adds the `Idempotency-Key` header's value (empty when the route does
not take one) and the raw body bytes after it:
`<timestamp>.POST.<path and query>.<idempotency key>.<raw body>`. Bodies are JSON, at most
64 KiB. See "Calling a write from Node" below.

In Node:

```js
import { createHmac } from 'node:crypto';

export async function erpGet(pathAndQuery) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', process.env.ERP_SITE_SECRET)
    .update(`${timestamp}.GET.${pathAndQuery}`)
    .digest('hex');
  const response = await fetch(`${process.env.ERP_API_URL}${pathAndQuery}`, {
    headers: {
      'X-Api-Key': process.env.ERP_SITE_KEY_ID,
      'X-Api-Timestamp': timestamp,
      'X-Api-Signature': `sha256=${signature}`,
    },
  });
  if (!response.ok) throw new Error(`storefront ${response.status}`);
  return response.json();
}
```

Every authentication failure — no headers, an unknown or revoked key, a key issued under a
different server secret, a timestamp more than five minutes either side, a signature for
another path or query — is the same `401 UNAUTHENTICATED` with the same sentence. The ERP's
log says which check failed. A proxy in front of the ERP must pass `/storefront/` through
without rewriting the path or the query string, or every signature fails.

## Reads

### `GET /catalog/products`

The shop: products that are **active** and **shown on the website**, with at least one active
size, newest first unless told otherwise.

| Parameter                          | Meaning                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `category`                         | A category slug or id; the list covers it and every visible category under it                            |
| `gender`                           | `men`, `women`, `kids` or `unisex`                                                                       |
| `tags`                             | Comma-separated; a product must carry every one                                                          |
| `size`                             | A size label or code (`M`, `XL`): products with an active SKU in that size                               |
| `minPricePoisha`, `maxPricePoisha` | Integer poisha; a product matches when any of its sizes is in range                                      |
| `featured`, `newArrival`, `onSale` | `true` or `false`. `onSale`: a size with a regular price above its price, or in a live flash sale (M39b) |
| `q`                                | Search words; every word must match the name, slug, SKU codes, tags, material or category                |
| `sort`                             | `newest` (default), `oldest`, `price-asc`, `price-desc`, `featured`, `name`                              |
| `limit`                            | 1 to 60, default 24                                                                                      |
| `cursor`                           | The `nextCursor` of the previous page (same sort)                                                        |
| `page`                             | 1 to 100, for a numbered shop; ignored when a cursor is sent                                             |

A malformed parameter is `400 VALIDATION_FAILED` naming it; an unknown parameter is ignored.

```json
{
  "items": [
    {
      "id": "…",
      "slug": "oxford-shirt",
      "name": "Oxford shirt",
      "category": { "id": "…", "slug": "shirts", "name": "Shirts" },
      "gender": "men",
      "tags": ["cotton", "summer"],
      "featured": true,
      "newArrival": false,
      "price": {
        "min": { "poisha": "250000", "taka": "2500.00" },
        "max": { "poisha": "250000", "taka": "2500.00" }
      },
      "compareAt": null,
      "onSale": false,
      "image": {
        "id": "…",
        "alt": "…",
        "width": 1600,
        "height": 2000,
        "urls": { "thumb": "…/thumb", "card": "…/card", "full": "…/full" }
      },
      "images": ["… up to two, the second for hover …"],
      "sizes": ["S", "M", "L"],
      "inStock": true
    }
  ],
  "nextCursor": "WyJuZXdlc3QiLC…",
  "total": 42,
  "page": null,
  "limit": 24
}
```

On a card (M39b, D-640), `price.min` and `price.max` are what a shopper pays **now** across the
sizes (a live flash price included, the same price the cart charges); `compareAt` is the
struck-through figure beside the lowest of them (a size's regular price, or with a flash price
the higher of the shelf price and the regular price), or null; `onSale` is true when any size is
discounted. Sorting by price uses the shelf prices.

### `GET /catalog/products/{slug}`

One product, or where it moved:

- shown at that address: `{ "product": { …the card above…, "description", "material",
"careInstructions", "seoTitle", "seoDescription", "breadcrumb": [{ id, slug, name }],
"images": [ … ], "sizeChart": { id, name, columns, rows } | null, "variants": [ … ],
"related": [ …up to four cards… ] } }`;
- an **old** address of a product that was renamed: `200 { "redirect": { "slug": "new-slug" } }`
  — answer the shopper with your own `301` to the new address. (Not an HTTP redirect from the
  ERP: `fetch` would follow it, and the path is part of the signature.)
- hidden, archived or unknown: `404 NOT_FOUND`.

Each variant: `{ "skuId", "sku", "size", "colour", "attributes": [{ "name", "value" }], "price",
"compareAt", "availableQty", "inStock" }`. `price` is what the shopper pays now (a live flash
price when one undercuts the shelf price); `compareAt` is struck through: with a flash price the
higher of the shelf price and the variant's regular price, without one its regular price, else
null (M39b). Each image carries `colour` (the colour it shows, or null for every colour), and
`galleries` groups them: `[{ "colour": null, "images": [ … ] }, { "colour": "Red", "images": [ … ] }]`,
every-colour photos first, so the page can switch photos when a shopper picks a colour. `availableQty` is live: on hand less what is held for
orders, at the stock locations the brand sells the website from (Website → Settings), and never
below zero. The answer may be thirty seconds old in your cache; M34's checkout holds the stock.

### `GET /catalog/categories`

The visible category tree: `{ "items": [{ id, slug, name, description, gender, featured, image,
position, children: [ … ] }] }`. A category switched off, or hidden from the website, takes
everything under it along.

### `GET /catalog/search?q=…&limit=8`

The search box: up to `limit` (at most 20) product cards, featured first.

### `GET /site`

Everything a page frame needs, in one answer (cached thirty seconds by the ERP):

```json
{
  "site": { "name": "…", "logo": { …image… } | null, "whatsapp": "", "phone": "", "email": "", "address": "" },
  "social": { "facebook": "", "instagram": "", "tiktok": "", "youtube": "" },
  "announcement": { "enabled": true, "text": "…", "link": "/shop" },
  "promoBanner": { "enabled": false, "headline": "", "subtext": "", "note": "", "decorativeText": "", "primaryLabel": "", "primaryHref": "", "secondaryLabel": "", "secondaryHref": "" },
  "testimonials": [{ "name": "…", "location": "…", "rating": 5, "text": "…" }],
  "hero": [{ "id": "…", "desktop": { …image… }, "mobile": { …image… } | null, "link": "/shop", "alt": "…" }],
  "menu": [{ "id": "…", "kind": "category", "label": "Menswear", "href": null, "category": { "id", "slug", "name" }, "highlighted": false, "children": [], "subcategories": [{ "id", "slug", "name", "children": [ … ] }] }],
  "shipping": { "freeShippingEnabled": true, "freeShippingThreshold": { "poisha": "150000", "taka": "1500.00" }, "zones": { "inside_dhaka": { "fee": { … } }, "suburbs": { "fee": { … } }, "outside_dhaka": { "fee": { … } } } },
  "payments": { "cod": true, "sslcommerz": false }
}
```

Menu entries are `link` (a path on the site or an `https://` address), `category` (expanded into
two levels of its visible subcategories) or `dropdown` (its own `children`). Links are checked by
the ERP when staff save them: never `javascript:`, never `//elsewhere`.

### `GET /size-charts/{id}`

`{ "sizeChart": { "id", "name", "columns": ["Size", "Chest (cm)"], "rows": [["M", "40"]] } }`.

### `GET /geo/districts` and `GET /geo/thanas?districtId=…`

The district and thana lists couriers deliver by, for M34's checkout:
`{ "items": [{ "id", "divisionId", "nameEn", "nameBn" }] }` and
`{ "items": [{ "id", "districtId", "nameEn", "nameBn" }] }`.

## Buying (M34)

Everything a shopper does that changes something: the cart, the checkout, accounts, the order
page and SSLCommerz (decisions D-520 to D-539). Same base, same keys, same signature, with the
idempotency key and the body signed as well. Every answer here is personal or moves with stock,
so it is `Cache-Control: no-store`; only the flash-sale reads are cached like the catalog.

The ERP sets **no cookie** for the website and keeps no shopper session. Account routes answer
with the account; the website keeps its own session (next-auth on the old site) and sends the
`accountId` back when it acts for that shopper. The ERP trusts that the website's server only
sends an `accountId` it signed in itself: protect the website key accordingly.

### The shopper's address on writes

The website's server is one address for every shopper. Send the shopper's own address (and, if
you like, the browser's user agent) as `client` on the account and checkout bodies, so the
limits count shoppers, not the website:

```json
"client": { "ip": "203.0.113.7", "userAgent": "Mozilla/5.0 …" }
```

Left out, every shopper shares one bucket and a busy evening may hit `429` (D-534).

### Errors you will handle

| Status | `code`                           | When                                                                                                    |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`              | A malformed body or parameter, a password under 8 characters or over 72 bytes; `detail` names the field |
| 400    | `ORDER_PHONE_INVALID`            | A phone that is not a Bangladeshi mobile                                                                |
| 400    | `IDEMPOTENCY_KEY_INVALID`        | A checkout without an `Idempotency-Key` (8 to 255 safe characters)                                      |
| 400    | `ACCOUNT_CODE_INVALID`           | An email code wrong, expired, used or tried five times; a dead reset link                               |
| 401    | `ACCOUNT_CREDENTIALS_INVALID`    | Sign-in: wrong email or password (one answer for both)                                                  |
| 403    | `ACCOUNT_EMAIL_UNVERIFIED`       | Sign-in with the right password before the email code was entered                                       |
| 404    | `NOT_FOUND`, `ACCOUNT_NOT_FOUND` | No such order, account or sale, or not this caller's                                                    |
| 409    | `CART_REPRICED`                  | The checkout's figures moved; carries `quote` (below)                                                   |
| 409    | `OUT_OF_STOCK`                   | A line cannot be held; carries `lines` (below)                                                          |
| 409    | `CART_NOT_DELIVERABLE`           | The address is in no delivery zone the brand ships to                                                   |
| 409    | `PAYMENT_METHOD_UNAVAILABLE`     | That way of paying is switched off, or the order is outside ৳10–৳5,00,000 for SSLCommerz                |
| 409    | `PAYMENT_NOT_PAYABLE`            | The order cannot be paid online now (paid, being checked, no longer pending, COD)                       |
| 409    | `IDEMPOTENCY_CONFLICT`           | An `Idempotency-Key` reused for a different checkout body                                               |
| 409    | `IDEMPOTENCY_IN_FLIGHT`          | The same checkout is still being placed; retry with the same key                                        |
| 409    | `ACCOUNT_EXISTS`                 | Registering an email that is already verified                                                           |
| 409    | `ACCOUNT_EMAIL_UNVERIFIED`       | Google sign-in for an address whose account never entered its code                                      |
| 409    | `ACCOUNT_GOOGLE_CONFLICT`        | That account is linked to another Google login                                                          |
| 409    | `ACCOUNT_NO_PASSWORD`            | Change password on an account that signs in only with Google                                            |
| 429    | `RATE_LIMITED`                   | With `Retry-After`                                                                                      |
| 502    | `PAYMENT_GATEWAY_FAILED`         | SSLCommerz refused to open a payment page; nothing was charged                                          |
| 503    | `SERVICE_UNAVAILABLE`            | SSLCommerz is slow; with `Retry-After`, try again                                                       |

A `409` that carries more than a sentence is problem+json with the extra member beside `code`:

```json
{
  "type": "…",
  "title": "…",
  "status": 409,
  "code": "OUT_OF_STOCK",
  "detail": "…",
  "lines": [
    { "skuId": "…", "variantId": null, "qty": 3, "reason": "not_enough_stock", "availableQty": 1 }
  ]
}
```

### `POST /cart/quote`

Prices a cart. Call it whenever the cart, the address or a code changes; it writes nothing.

```json
{
  "lines": [
    { "skuId": "…", "qty": 2 },
    { "variantId": "64f0c…", "qty": 1 }
  ],
  "address": { "districtId": 47, "thanaId": 512 },
  "codes": ["EID10"],
  "accountId": "…",
  "phone": "01712345678"
}
```

- `lines`: 1 to 50, each naming a SKU id **or** the old website's variant id, `qty` 1 to 20.
  Two lines of one SKU are added together.
- `address`: optional; without it there is no delivery charge and `deliverable` is `false`.
- `codes`: up to five typed discount codes. Automatic discounts and live flash prices apply
  without one.
- `accountId` or `phone`: optional, so per-customer discount limits can be counted.

```json
{
  "quote": {
    "lines": [{ "skuId": "…", "sku": "OX-M-WHT", "name": "Oxford shirt", "slug": "oxford-shirt",
                "size": "M", "colour": "White", "qty": 2,
                "unitPrice": { "poisha": "200000", "taka": "2000.00" },
                "compareAt": { "poisha": "250000", "taka": "2500.00" },
                "lineTotal": { "poisha": "400000", "taka": "4000.00" },
                "availableQty": 7, "flashSale": true }],
    "unavailable": [{ "skuId": null, "variantId": "64f0c…", "qty": 1, "reason": "not_found", "availableQty": 0 }],
    "discounts": [{ "code": "EID10", "title": "Eid 10%", "kind": "percent", "automatic": false,
                    "amount": { … }, "deliveryAmount": { … } }],
    "codes": [{ "code": "EID10", "applied": true, "reason": null }],
    "items": { … }, "discount": { … }, "delivery": { … }, "deliveryDiscount": { … },
    "total": { "poisha": "372000", "taka": "3720.00" },
    "deliverable": true, "zone": "inside_dhaka", "freeShipping": false
  }
}
```

`unavailable[].reason` is `not_found`, `not_on_website`, `sold_out` or `not_enough_stock`
(`availableQty` says how many are left); those lines are in no total. `codes[].reason` is null
when applied, else the discount engine's reason (`not_found`, `expired`, `minimum_not_met`, …).
`compareAt` is struck through beside the line: with a flash price the higher of the shelf price
and the variant's regular price, without one its regular price (M39b), else null.
`total` = items − discount + delivery − deliveryDiscount, never below zero. Free shipping is on
when Website → Settings switches it on and the items reach the threshold (no threshold: always).

### `POST /checkout`

Places the order. **`Idempotency-Key` is required** (a fresh UUID per "Place order" press,
reused on a retry of that press). Signed over the key and the raw body.

```json
{
  "lines": [{ "skuId": "…", "qty": 2 }],
  "contact": { "name": "Rahim Uddin", "phone": "01712345678", "email": "rahim@example.com" },
  "address": {
    "districtId": 47,
    "thanaId": 512,
    "area": "Dhanmondi 27",
    "addressLine": "House 5, Road 3"
  },
  "codes": ["EID10"],
  "accountId": "…",
  "paymentMethod": "cod",
  "notes": "Call before coming",
  "locale": "bn",
  "expected": { "totalPoisha": "372000", "lines": [{ "skuId": "…", "unitPricePoisha": "200000" }] },
  "client": { "ip": "203.0.113.7" }
}
```

- `contact.email` is optional for `cod` and **required** for `sslcommerz`.
- `paymentMethod`: `cod` (when Settings allows cash on delivery) or `sslcommerz` (when Settings
  and Website → Payments both allow it and the order is at least ৳10).
- `expected`: the quote the shopper confirmed. If the total or any listed line's unit price
  differs now, nothing is placed: `409 CART_REPRICED` with `quote`, the fresh figures. Show them
  and ask again.
- `locale`: the language of the shopper's emails when there is no account (default `bn`).

`201`:

```json
{
  "order": {
    "orderNo": "WEB-…",
    "status": "placed",
    "viewToken": "x9…43 characters",
    "total": { "poisha": "372000", "taka": "3720.00" },
    "payment": { "method": "sslcommerz", "required": true }
  }
}
```

The stock is held from this moment, at one web location. Keep `viewToken` with the shopper (the
confirmation page's link, `/order-confirmation/<orderNo>?token=<viewToken>`, is what the emails
send too); the ERP stores only its hash and cannot show it again. A retry with the same key and
body answers `201` again with `Idempotency-Replayed: true`, the same order and a **new** view
token (both work). The same key with a different body: `409 IDEMPOTENCY_CONFLICT`.

When `payment.required` is true, go straight to `POST /payments/sslcommerz/init`. An online
order not paid within 60 minutes is cancelled and its stock released.

Refusals: `409 OUT_OF_STOCK` (two shoppers raced for the last unit, or no single location holds
every line) with `lines`; `409 CART_REPRICED`; `409 CART_NOT_DELIVERABLE`;
`409 PAYMENT_METHOD_UNAVAILABLE`; `400 ORDER_PHONE_INVALID`; `400 VALIDATION_FAILED` for a
missing email with SSLCommerz; `429` past 30 checkouts in ten minutes from one shopper address.

### Accounts

All `POST` except where shown. Every answer that names an account gives the same view:

```json
{
  "account": {
    "id": "…",
    "email": "rahim@example.com",
    "emailVerified": true,
    "name": "Rahim",
    "phone": "+8801712345678",
    "locale": "bn",
    "hasPassword": true,
    "googleLinked": false,
    "addresses": [
      {
        "id": "…",
        "label": "Home",
        "name": "…",
        "phone": "…",
        "districtId": 47,
        "thanaId": 512,
        "area": "…",
        "addressLine": "…",
        "isDefault": true
      }
    ],
    "createdAt": "2026-10-05T10:00:00.000Z"
  }
}
```

| Route                           | Body                                                                 | Answer                                                                              |
| ------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `accounts/register`             | `{ email, password, name, phone?, locale?, client? }`                | `201 { accountId, requiresVerification: true, email }`; a six-digit code is emailed |
| `accounts/verify-email`         | `{ email, code, client? }`                                           | `{ account }`; past guest orders that gave this email join the account (D-523)      |
| `accounts/resend-code`          | `{ email, client? }`                                                 | `{ ok: true }`, whether or not the address has an account                           |
| `accounts/sign-in`              | `{ email, password, client? }`                                       | `{ account }`, `401`, `403 ACCOUNT_EMAIL_UNVERIFIED` or `429`                       |
| `accounts/google`               | `{ email, emailVerified: true, googleSub, name?, locale?, client? }` | `{ account, created }`                                                              |
| `accounts/forgot-password`      | `{ email, client? }`                                                 | `{ ok: true }` always; a one-hour link is emailed if it exists                      |
| `accounts/reset-password`       | `{ token, password, client? }`                                       | `{ accountId }`; the email counts as verified                                       |
| `GET accounts/{id}`             | —                                                                    | `{ account }`                                                                       |
| `PATCH accounts/{id}`           | `{ name?, phone? (null clears), locale?, addresses? }`               | `{ account }`; `addresses` replaces the list (at most 10)                           |
| `accounts/{id}/change-password` | `{ currentPassword, newPassword }`                                   | `{ ok: true }`                                                                      |

- **Google**: the website verifies Google's ID token itself (signature, audience, expiry) and
  sends what it says. The ERP signs in by `googleSub`, else creates an account for the address,
  else links Google to the existing account **only if that account's email is verified**
  (otherwise `409 ACCOUNT_EMAIL_UNVERIFIED`: ask the shopper to verify or reset first).
- The reset link the email carries is `<site>/auth/reset-password?token=<token>` (the old site's
  page), and the email code
  is typed on the website's verify page. Neither the code nor the token is ever in an answer.
- Codes last 15 minutes and allow five tries; a new code ends the old ones.

### The shopper's orders

| Route                                       | Answer                                                         |
| ------------------------------------------- | -------------------------------------------------------------- |
| `GET orders/{orderNo}?token=<viewToken>`    | `{ order }` for a guest's link (or an account's order)         |
| `GET accounts/{id}/orders?cursor=&limit=20` | `{ items: [summary], nextCursor }`, newest first, `limit` ≤ 50 |
| `GET accounts/{id}/orders/{orderNo}`        | `{ order }`                                                    |

```json
{ "order": {
    "orderNo": "WEB-…", "status": "shipped", "statusLabel": { "en": "Shipped", "bn": "পাঠানো হয়েছে" },
    "placedAt": "…", "total": { … }, "itemCount": 3, "paymentMethod": "cod",
    "confirmedAt": "…", "shippedAt": "…", "deliveredAt": null, "cancelledAt": null,
    "items": { … }, "discount": { … }, "delivery": { … }, "paid": { … }, "dueOnDelivery": { … },
    "payment": { "method": "cod", "status": "cash_on_delivery", "paidOnline": { … } },
    "shipTo": { "name": "…", "phone": "+880…", "districtId": 47, "thanaId": 512,
                "district": { "nameEn": "Dhaka", "nameBn": "ঢাকা" }, "thana": { "nameEn": "…", "nameBn": "…" },
                "area": "…", "addressLine": "…" },
    "lines": [{ "skuId": "…", "sku": "OX-M-WHT", "name": "Oxford shirt", "qty": 2,
                "unitPrice": { … }, "lineTotal": { … } }],
    "tracking": { "courier": "Pathao", "trackingCode": "…" } } }
```

A summary is the first seven members. `status` is the shopper's word: `placed`, `processing`,
`shipped`, `delivered`, `partly_delivered`, `returned`, `cancelled` or `exchanged`.
`payment.status` is `cash_on_delivery`, `awaiting_payment`, `paid` or `refund_due`. `tracking` is
null until a parcel is booked. Only website orders are ever shown; a wrong token is `404`.

### SSLCommerz

1. `POST payments/sslcommerz/init` with `{ "orderNo", "token" }` (a guest) or
   `{ "orderNo", "accountId" }`. The ERP opens a session with SSLCommerz (waiting up to 15
   seconds) and answers `{ "payment": { "gatewayUrl", "tranId", "amount": { poisha, taka },
"expiresAt" } }`. Redirect the shopper to `gatewayUrl`. Calling it again while the session is
   open returns the same page.
2. SSLCommerz sends the shopper back to the website at
   `<site>/api/payment/sslcommerz/success|fail|cancel` with a form post carrying `tran_id` and,
   on success, `val_id`. Relay it: `POST payments/sslcommerz/return` with
   `{ "kind": "success", "tranId": "<tran_id>", "valId": "<val_id>" }` (or `kind: "fail"` /
   `"cancel"` with no `valId`). The ERP checks the payment with SSLCommerz's validation API
   (status, transaction, currency and the exact amount) and answers
   `{ "payment": { "orderNo", "status": "paid" | "refused" | "checking" | "cancelled" } }`.
   `checking` means SSLCommerz was slow (or the return carried no `val_id`); show "we are
   confirming your payment" and read the order a little later. A fail or cancel cancels the
   unpaid order, unless a payment of it is still being checked.
3. SSLCommerz also calls the ERP directly (the IPN, `POST /storefront/ipn/sslcommerz/<org id>`,
   set by the ERP on every session). It needs no key and nothing in it is believed: it only
   prompts the same validation. Let it through any proxy unchanged.

Never mark an order paid on the website's side: read it back (`payment.status`).

### Flash sales (M35)

`GET /flash-sales` (add `?home=true` for the ones marked for the home page) →
`{ "items": [sale] }`, live and scheduled sales; `GET /flash-sales/{slug}` → `{ "flashSale": sale }`
or `404`. Cached like the catalog (`ETag`, thirty seconds).

```json
{ "id": "…", "slug": "eid-flash", "title": "Eid flash sale", "subtitle": "…", "description": "…",
  "status": "live", "startsAt": "…", "endsAt": "…", "showOnHome": true,
  "banner": { …image… } | null,
  "items": [{ "skuId": "…", "sku": "OX-M-WHT",
              "product": { "id": "…", "slug": "oxford-shirt", "name": "Oxford shirt" },
              "size": "M", "colour": "White",
              "price": { "poisha": "150000", "taka": "1500.00" },
              "compareAt": { "poisha": "250000", "taka": "2500.00" },
              "unitsLeft": 4, "image": { …image… } | null }] }
```

A `scheduled` sale has `price: null` on every item until it starts (D-538). Only SKUs the website
sells are listed; a sale with none is not shown. The price a shopper pays comes from the quote
and the checkout: a flash price needs a unit of the sale's allowance, claimed when the order is
placed, so a quote may show the sale price and the checkout still answer `409 CART_REPRICED` if
the last unit went to someone else.

### Calling a write from Node

```js
import { createHmac, randomUUID } from 'node:crypto';

export async function erpPost(path, body, { idempotencyKey = '', method = 'POST' } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', process.env.ERP_SITE_SECRET)
    .update(`${timestamp}.${method}.${path}.${idempotencyKey}.${raw}`)
    .digest('hex');
  return fetch(`${process.env.ERP_API_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.ERP_SITE_KEY_ID,
      'X-Api-Timestamp': timestamp,
      'X-Api-Signature': `sha256=${signature}`,
      ...(idempotencyKey === '' ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: raw,
  });
}

// await erpPost('/storefront/v1/checkout', order, { idempotencyKey: randomUUID() });
```

Sign the exact bytes you send: serialise once and send that string.

## Images

Image URLs in every answer point at `<STOREFRONT_MEDIA_BASE_URL>/media/<org id>/<file id>/<thumb|card|full>`
(the API's public address unless the brand sets a CDN in front of `/media/`)
(160, 640 and 1600 pixels on the longest side, WebP, metadata stripped). They are public,
served with `Cache-Control: public, max-age=31536000, immutable` and the variant's SHA-256 as
`ETag`, so a browser or the website's image optimiser may load them directly. Only product,
category and website images and flash-sale banners that staff uploaded as public are served;
everything else is `404`.

## Rate limits

Generous, because one website server makes every shopper's reads: 6,000 requests a minute from
one address and 3,000 a minute per key by default (`STOREFRONT_RATE_*`). Over the limit:
`429 RATE_LIMITED` with `Retry-After`.

Per shopper (M34, D-534), counted by the `client.ip` the website sends and by email: sign-in 8
tries in ten minutes; email codes and reset links 4 in fifteen minutes per address; registering,
verifying, resetting and Google sign-ins 20 in fifteen minutes; checkouts 30 in ten minutes.

## What the website never receives

The answers are built field by field and then passed through an allow-list that names every
key at every depth (`STOREFRONT_VISIBLE_FIELDS`): no purchase cost, no supplier, no stock
location, no internal note can reach the website, and a field added to the ERP stays out until
somebody decides the website needs it. The merchant id printed on courier labels is not sent.
Nor are a password hash, an email code, a reset or view token's hash, Google's account id, the
staff who handled an order or the SSLCommerz store password.
