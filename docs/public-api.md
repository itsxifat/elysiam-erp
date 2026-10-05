# Public order intake API

For developers building a brand's landing pages or connecting an existing brand website (D-024) to the brand's ERP. It covers one endpoint: posting an order.

Every order posted here arrives as a **pending** order in the brand's **unassigned queue**. Sales agents confirm it by phone, as they would a Facebook order. Nothing you send can confirm an order, set a price, or assign it to someone.

## At a glance

| What            | Value                                                             |
| --------------- | ----------------------------------------------------------------- |
| Endpoint        | `POST https://<api host>/public/v1/orders`                        |
| Body            | JSON, UTF-8, at most 64 KiB                                       |
| Authentication  | A per-site key id plus an HMAC-SHA256 signature over the raw body |
| Bot check       | A Cloudflare Turnstile token from the visitor's browser           |
| Idempotency     | An `Idempotency-Key` header is **required**                       |
| Clock tolerance | ±5 minutes                                                        |
| Success         | `201` with `{ orderId, orderNo, status }`                         |
| Errors          | RFC 9457 `application/problem+json` with a stable `code`          |

## Call it from your server, never from the browser

The signing secret must never reach a visitor's browser. Anyone who can read it can post orders as your site.

1. The browser shows the order form with a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) widget.
2. The form submits to **your** server: a Next.js route handler or server action, or whatever your site runs on.
3. Your server builds the JSON body, including the Turnstile token and the visitor's IP address, signs it, and posts it here.

## Getting a key

An org admin or a marketing user issues a key for each site in the ERP (`POST /v1/intake/site-keys` with a label). The response carries two values:

- `keyId`: `pk_…`. Public. Sent on every request.
- `secret`: `sk_…`. **Shown once and never again.** Store it in your site's secret manager, for example as a Vercel environment variable. If you lose it, ask for a new key and have the old one revoked.

The key decides the order's channel: `landing_page`, or `website` for an existing brand site. It can also stamp a landing page id on every order. You cannot set either from the request.

The Turnstile **site key** for your widget comes from the brand's Cloudflare account. The ERP holds the matching **secret key**.

## Request

### Headers

| Header            | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| `Content-Type`    | `application/json`                                             |
| `X-Api-Key`       | Your key id, `pk_…`                                            |
| `X-Api-Timestamp` | Unix time in **seconds**, as decimal digits, e.g. `1790000000` |
| `X-Api-Signature` | `sha256=` followed by the lower-case hex HMAC (see below)      |
| `Idempotency-Key` | 8–255 printable ASCII characters, unique per order; use a UUID |

An integration built before these header names keeps working: the API still reads the
names it sends. New integrations use the names above.

### Signing

```
signature = HMAC-SHA256(secret, timestamp + "." + idempotencyKey + "." + rawBody)
header    = "sha256=" + hex(signature)
```

- `rawBody` is the **exact bytes** you send. Serialise the JSON once, sign that string, and send that same string. Re-serialising after signing, or letting a library pretty-print it, breaks the signature.
- The idempotency key is part of what is signed. A captured request therefore cannot be replayed as a _new_ order: changing the key invalidates the signature.
- The timestamp must be within five minutes of the server's clock, in either direction. Keep your server's clock synchronised (NTP).

Node.js reference implementation:

```ts
import { createHmac, randomUUID } from 'node:crypto';

export async function postOrder(order: object): Promise<Response> {
  const body = JSON.stringify(order); // sign exactly these bytes, send exactly these bytes
  const timestamp = String(Math.floor(Date.now() / 1000));
  const idempotencyKey = randomUUID(); // keep it: retries must reuse it
  const signature = createHmac('sha256', process.env.ERP_SITE_SECRET!)
    .update(`${timestamp}.${idempotencyKey}.${body}`)
    .digest('hex');

  return fetch(`${process.env.ERP_API_URL}/public/v1/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ERP_SITE_KEY_ID!,
      'x-api-timestamp': timestamp,
      'x-api-signature': `sha256=${signature}`,
      'idempotency-key': idempotencyKey,
    },
    body,
  });
}
```

### Body

```json
{
  "customer": { "name": "রহিমা খাতুন", "phone": "01711-223344" },
  "address": {
    "districtId": 47,
    "thanaId": 365,
    "area": "Hemayetpur",
    "addressLine": "House 4, Road 2"
  },
  "lines": [{ "skuCode": "ELY-SHRT-0042-BLK-M", "qty": 1 }],
  "notes": "Call before delivery",
  "utm": {
    "source": "facebook",
    "medium": "cpc",
    "campaign": "eid-2026",
    "content": "carousel-2",
    "term": "kurta"
  },
  "turnstileToken": "<the token the widget produced>",
  "visitor": { "ip": "203.0.113.7" }
}
```

| Field                 | Required | Rules                                                                                                              |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `customer.name`       | yes      | 1–200 characters                                                                                                   |
| `customer.phone`      | yes      | A Bangladeshi mobile number in any common spelling: `01…`, `+880…`, `880…`, spaces, dashes or Bangla digits        |
| `address.districtId`  | yes      | The ERP's district id (the same reference data the order desk uses)                                                |
| `address.thanaId`     | yes      | The ERP's thana/upazila id, inside that district                                                                   |
| `address.area`        | no       | Up to 160 characters                                                                                               |
| `address.addressLine` | yes      | 3–500 characters                                                                                                   |
| `lines`               | yes      | 1–20 lines. Each line names **either** `skuCode` **or** `skuId`, with `qty` between 1 and 20. Name a SKU only once |
| `notes`               | no       | Up to 500 characters, shown to the agent who confirms                                                              |
| `utm.*`               | no       | Up to 120 characters each. Stored on the order for attribution                                                     |
| `turnstileToken`      | yes      | The widget's token, at most 2048 characters. Tokens are single-use and live 300 seconds                            |
| `visitor.ip`          | no       | The visitor's IPv4 or IPv6 address. Used for the per-visitor rate limit and passed to Turnstile. Send it           |

The address is used for this order only; it does not change a returning buyer's saved address. Unknown fields are refused, so a typo does not silently drop data. Prices, discounts, delivery charges, channels, assignees and statuses **cannot** be sent: the catalog prices the lines, and the delivery zone for the address sets the delivery charge.

## Response

`201 Created`:

```json
{ "orderId": "0d4e…", "orderNo": "ELY-2609-00042", "status": "pending" }
```

A retry with the same `Idempotency-Key` and the same body returns the same order, also `201`, with the header `Idempotency-Replayed: true`. Turnstile is not asked again, so the spent token in a retried body is fine.

## Errors

Every error is `application/problem+json`. Branch on `code`, not on the wording.

| Status | `code`                    | Meaning and what to do                                                                                                                   |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`       | The body breaks a rule above. Fix it; do not retry as-is.                                                                                |
| 400    | `ORDER_PHONE_INVALID`     | Not a Bangladeshi mobile number. Ask the visitor to correct it.                                                                          |
| 400    | `ORDER_LINES_INVALID`     | An unknown, archived or repeated SKU.                                                                                                    |
| 400    | `IDEMPOTENCY_KEY_INVALID` | The `Idempotency-Key` header is missing or malformed.                                                                                    |
| 401    | `UNAUTHENTICATED`         | Unknown or revoked key, wrong secret, a stale timestamp or a bad signature. The response does not say which, on purpose. Check all four. |
| 403    | `FORBIDDEN`               | The Turnstile check failed. Show the widget again and resubmit. You may reuse the same `Idempotency-Key` with the new token.             |
| 409    | `IDEMPOTENCY_CONFLICT`    | That `Idempotency-Key` was already used for a different body. Use a new key for a new order.                                             |
| 409    | `IDEMPOTENCY_IN_FLIGHT`   | The first request with this key is still being processed. Retry in a few seconds with the same key and body.                             |
| 413    | `PAYLOAD_TOO_LARGE`       | Body over 64 KiB.                                                                                                                        |
| 429    | `RATE_LIMITED`            | Too many orders from this visitor, this phone number, this site or your server. Wait for `Retry-After` seconds.                          |
| 503    | `SERVICE_UNAVAILABLE`     | The Turnstile check could not be completed, or intake is not configured on the server. Retry later with the same key.                    |

### Retrying

- Retry only on `409 IDEMPOTENCY_IN_FLIGHT`, `429`, `503` and network failures. Always reuse the **same** `Idempotency-Key` and the **same** body, and re-sign with a fresh timestamp.
- Never retry a `400` or `401` unchanged.
- A `403` needs a fresh Turnstile token from the visitor.

## Rate limits

Counted per window. Defaults, each configurable by the operator:

| Bucket                                      | Default        |
| ------------------------------------------- | -------------- |
| Your server's IP, before any check          | 120 per minute |
| One site key                                | 300 per minute |
| One visitor IP (from `visitor.ip`) per site | 10 per minute  |
| One phone number per brand                  | 5 per hour     |

A replay of an existing order does not count against the site, visitor or phone buckets.

Send `visitor.ip`. Without it the per-visitor bucket falls back to your server's address, and every visitor of your site then shares one bucket of 10 per minute. The server-IP bucket is shared too: sites on a host with shared egress addresses (Vercel, for example) count against one another. Ask the operator to raise `INTAKE_RATE_SOURCE_IP_PER_MINUTE` if your sites share egress.

## Testing

- Use Cloudflare's [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/): the sitekey `1x00000000000000000000AA` always passes, and its token `XXXX.DUMMY.TOKEN.XXXX` is accepted when the ERP runs with the matching test secret. Production secret keys reject dummy tokens.
- Point your staging site at a staging API with its own key. Keys are per brand and per environment.

## Security notes

- The ERP never stores your secret, even encrypted. It stores a fingerprint and derives the secret from a server-side master key when a request arrives. A leaked ERP database cannot sign a request.
- Rotate a key by issuing a new one, deploying it, then revoking the old one. A revoked key is refused immediately.
- The phone number is personal data. Do not log it in your own site's logs, and mask it if you must (`017******44`).

## Reading the catalog for a brand's own website

This endpoint takes orders from landing pages. A brand's own website reads its products,
categories, menu and settings through a different, read-only API with its own keys, issued on
**Website → Connection**: see [`storefront-api.md`](storefront-api.md) (M33).
