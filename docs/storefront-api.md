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
| Methods         | `GET` (M33). `POST` arrives with M34's checkout                                        |
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

A `POST` (M34) adds the `Idempotency-Key` header's value and the raw body bytes after it:
`<timestamp>.POST.<path and query>.<idempotency key>.<raw body>`.

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

| Parameter                          | Meaning                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `category`                         | A category slug or id; the list covers it and every visible category under it             |
| `gender`                           | `men`, `women`, `kids` or `unisex`                                                        |
| `tags`                             | Comma-separated; a product must carry every one                                           |
| `size`                             | A size label or code (`M`, `XL`): products with an active SKU in that size                |
| `minPricePoisha`, `maxPricePoisha` | Integer poisha; a product matches when any of its sizes is in range                       |
| `featured`, `newArrival`, `onSale` | `true` or `false`. `onSale` matches nothing until M35's flash sales                       |
| `q`                                | Search words; every word must match the name, slug, SKU codes, tags, material or category |
| `sort`                             | `newest` (default), `oldest`, `price-asc`, `price-desc`, `featured`, `name`               |
| `limit`                            | 1 to 60, default 24                                                                       |
| `cursor`                           | The `nextCursor` of the previous page (same sort)                                         |
| `page`                             | 1 to 100, for a numbered shop; ignored when a cursor is sent                              |

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
"compareAt", "availableQty", "inStock" }`. `availableQty` is live: on hand less what is held for
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

## Images

Image URLs in every answer point at `https://<api host or CDN>/media/<org id>/<file id>/<thumb|card|full>`
(160, 640 and 1600 pixels on the longest side, WebP, metadata stripped). They are public,
served with `Cache-Control: public, max-age=31536000, immutable` and the variant's SHA-256 as
`ETag`, so a browser or the website's image optimiser may load them directly. Only product,
category and website images that staff uploaded as public are served; everything else is `404`.

## Rate limits

Generous, because one website server makes every shopper's reads: 6,000 requests a minute from
one address and 3,000 a minute per key by default (`STOREFRONT_RATE_*`). Over the limit:
`429 RATE_LIMITED` with `Retry-After`.

## What the website never receives

The answers are built field by field and then passed through an allow-list that names every
key at every depth (`STOREFRONT_VISIBLE_FIELDS`): no purchase cost, no supplier, no stock
location, no internal note can reach the website, and a field added to the ERP stays out until
somebody decides the website needs it. The merchant id printed on courier labels is not sent.
