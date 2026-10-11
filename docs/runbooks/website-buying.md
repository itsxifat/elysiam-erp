# Website buying: payments, email and the old site's customers

For whoever switches a brand's website over to buying through its ERP (M34, decisions D-520 to
D-539). The website's side is `docs/storefront-api.md`; this is the ERP's side.

## 1. The credentials key (once per installation)

The SSLCommerz store password, the email server's password and emails waiting to be sent are
sealed with `STOREFRONT_CREDENTIALS_KEY` (D-528). Without it, Website → Payments and Website →
Email say "the credentials key is not set" and refuse to save.

```sh
openssl rand -base64 32          # STOREFRONT_CREDENTIALS_KEY
# STOREFRONT_CREDENTIALS_KEY_ID=k1  (any short name; change it when the key changes)
```

Put both in the API's and the worker's environment (the same values in both) and restart them.
On a brand server that is `BRAND_STOREFRONT_CREDENTIALS_KEY` in the brand's `.env.brand`
(`infra/brand/new-brand.sh` writes one for a new brand; a brand made before M34 adds the line)
and a redeploy; on the preview it is `PREVIEW_STOREFRONT_CREDENTIALS_KEY`; with Kamal,
`<ENV>_STOREFRONT_CREDENTIALS_KEY`. A worker without the key cannot check payments: the checks
fail and are retried (reported in the failed jobs) until it has it, and no payment is refused
for it.
Keep the key with the other secrets (`docs/runbooks/secret-rotation.md`). Changing it makes the
stored passwords unreadable: re-enter the SSLCommerz and email passwords afterwards. An email
sealed under the old key and not yet sent is recorded as skipped.

## 2. Email (Website → Email, org admin)

1. Enter the brand's SMTP server (host, port, the user and password, the name and address the
   emails come from). Port 465 is TLS from the start (tick it); any other port must offer
   STARTTLS, or sending fails.
2. Tick "Send emails", save, and use **Send test** to an inbox you can read. The answer is what
   the server said; a refusal names it.
3. The log below lists every email with its state: `sent`, `queued` (tries again, three times),
   `failed` (with the server's reason) or `skipped` (email switched off, the training org, or no
   key). Addresses are masked in the server's logs, never in this list.

Shoppers get: the six-digit email code, the password link, and order placed, confirmed,
shipped (with the tracking code), delivered and cancelled, in English (D-750). The order
emails link to `<website address>/order-confirmation/<order no>?token=…`, so set the "Website
address" on Website → Settings (`https://…`) first; without it the emails go without the link.

## 3. SSLCommerz (Website → Payments, org admin)

A **sandbox** store takes no money on a server where `STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX` is
not `true` (the default): SSLCommerz's test cards are public, so a sandbox store on a live
website would let anyone "pay". Do the sandbox run on a staging or preview server with the flag
on, or on the live server for the duration of the test only, then turn it off again.

1. Set the "Website address" on Website → Settings (`https://…`): SSLCommerz sends the shopper
   back to `<website address>/api/payment/sslcommerz/success|fail|cancel`, and no payment page
   opens without it. Ask SSLCommerz for a **sandbox** store for the brand. Enter the store id
   and password, mode `sandbox`, and tick "Take online payments". Saving creates the clearing
   wallet, `1120 SSLCommerz clearing`, if it is not there yet.
2. Copy the **IPN address** the screen shows (`<API_PUBLIC_URL>/storefront/ipn/sslcommerz/<org
id>`) into the store's IPN setting in SSLCommerz's merchant panel. The ERP also sends it with
   every payment. A proxy in front of the API must pass `/storefront/ipn/` through unchanged,
   form bodies included.
3. Switch on SSLCommerz in Website → Settings → Payment methods as well: the website offers it
   only when both are on (D-537).
4. Place a sandbox order from the website with a test card. Check, in the ERP: the order's
   page shows the payment as paid, the order's COD dropped by the amount, and Money → wallet
   `SSLCommerz clearing` grew by it (Dr clearing / Cr customer advance).
5. Try a failed and a cancelled payment: the order is cancelled and its stock released. Leave
   one unpaid: it is cancelled 60 minutes after the checkout (`STOREFRONT_UNPAID_ORDER_MINUTES`).
6. Only then change the mode to `live` with the live store id and password. The adapter is
   recorded as UNVERIFIED in `docs/decisions.md` until this sandbox run has been done once.

**When SSLCommerz settles** to the bank, accounts records a wallet transfer from `SSLCommerz
clearing` to the bank wallet for the amount received, and the gateway's fee as an expense from
the clearing wallet (a follow-up will read SSLCommerz's settlement report).

**A refused payment** (the validated amount or order did not match, or a second page was paid
for one order) shows as `refused` on the order's page and on Website → Payments, and is in the
audit log. The shopper was charged, so the money is booked into the clearing wallet as an
advance owed back (refund due on the order's advances): refund it from SSLCommerz's merchant
panel, settle the refund on the order, and tell the shopper. A refusal for a wrong currency, a
sandbox payment on a live server or a store switched to the other mode books nothing: check it
in the panel. A payment that
arrives after its order was cancelled is booked as an advance owed back: refund it the same way
and settle it on the order's advances.

## 4. The old site's customers (optional, D-531)

Only if the owner decides shoppers should keep their accounts and passwords. Orders and their
history are not imported (D-561).

1. Export the old site's `users` collection:

   ```sh
   mongoexport --uri "<old site's MongoDB URI>" --collection users --jsonArray --out users.json
   ```

   The file holds personal data and password hashes: keep it on the server, never in the repo,
   and delete it when done.

2. Build the server (`pnpm --filter @elysium/server build`) and, with `DATABASE_URL` pointing at
   the brand's database, dry-run:

   ```sh
   pnpm migration legacy-customers --org <slug> dry-run --file users.json
   ```

   The report gives counts (accounts, with a password, Google-only, verified, buyers, staff left
   out, guests, duplicates, already imported, invalid) and the row numbers left out or imported
   with a warning, with the reason. It never prints a name, an email or a phone.

3. Commit:

   ```sh
   pnpm migration legacy-customers --org <slug> commit --file users.json
   ```

   One transaction: all of it or nothing. Running it again writes nothing new. Shoppers sign in
   with their old email and password; a Google sign-up signs in with Google; an account whose
   old hash was not bcrypt uses "forgot password".

Staff accounts of the old site are not imported: invite those people to the ERP instead.
