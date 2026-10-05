# Wave 3: one ERP per brand, a mother ERP above them, and the brand's website run from its ERP

> Written on 2026-10-05 from the owner's instruction of that day (D-469). The milestone plans
> are M31 to M37 in this folder.

## The owner's instruction, in short

- One **mother ERP**: its own server, its own domain. The owner (super admin) sees and handles
  every brand's data there, and sees combined figures for everything.
- Every business gets its **own ERP**: one shared UI codebase, but its own server instance and
  its own database. A brand's ERP never says it is a "child", has no link to any other brand,
  and gives no clue that a mother ERP exists.
- Two servers: one for the mother, one for the brands.
- Each brand's ERP is also **its website's back office**: orders, customers, leads, offers,
  discounts, the website's look, staff, everything. Business models can differ per brand.
- First: Elysium Lifestyle BD's website (`D:\Projects\elysium`) is fully converted, so its old
  `/admin` panel is no longer used. CRM, a shared inbox and finer staff control come after.

## Shape

```
                 mother server                                   brands server
   ┌───────────────────────────────────┐        ┌────────────────────────────────────────────┐
   │ mother.<domain>                   │  SSH   │ erp-elysium   (API, worker, Postgres, …)   │
   │  mother-console  →  mother-server │ ─────► │ erp-oura      (API, worker, Postgres, …)   │
   │  own Postgres (owners, brands,    │ tunnel │ erp-orvo      …                            │
   │  pulled figures)                  │ read-  │ erp-wearx     …                            │
   └───────────────────────────────────┘ only   │ erp-beownz    …                            │
                │ one-time owner link            └────────────────────────────────────────────┘
                ▼ (signed; checked with a public key in the brand's env)          ▲
         admin.<brand domain>  (the brand's ERP console)                          │ signed
                                                                                   │ server calls
         <brand domain>  (the brand's website, Next.js, no database)  ─────────────┘
```

- The brands never call the mother. The mother reads each brand's database with the read-only
  role every brand database already has, over an SSH tunnel, and signs the owner into a brand
  with a one-time link.
- A brand's website has no database. Its server calls the brand ERP's storefront API with a
  signed key; shoppers' browsers never talk to the ERP.

## The old admin panel, feature by feature

| Old `/admin`                                            | Where it goes                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| Dashboard, analytics                                    | ERP dashboards (M24) and the mother (M32)                            |
| Orders, new order, edit, returns, courier send and sync | ERP order desk, returns, courier (M10–M17)                           |
| Products, SKUs, images, master sizes                    | ERP catalog (M06, catalog-stock-ux) + web fields (M33)               |
| Categories                                              | ERP catalog setup + web fields (M33)                                 |
| Size charts, hero, navbar, site settings, shipping      | ERP **Website** section (M33)                                        |
| Customers, duplicates, export                           | ERP buyers (M11, M16) + website accounts (M34)                       |
| Roles, staff, PIN                                       | ERP staff, roles, two-step sign-in, approvals (M02, gaps-users-auth) |
| Discounts                                               | ERP discounts, extended (M35)                                        |
| Flash sales, landing pages, custom URLs                 | ERP **Website** section (M35)                                        |
| Tracking (pixel, CAPI, GA4)                             | ERP **Website → Tracking** (M35)                                     |
| Steadfast settings, webhook                             | ERP couriers (M12, M15)                                              |
| ncom.bd connector                                       | ERP connector (M35)                                                  |
| Scan page, scanner app                                  | ERP **Scan** page and scanner routes (M35)                           |
| Labels                                                  | ERP order labels (M35)                                               |
| Notifications and their routing                         | ERP notifications (M04, M24)                                         |
| Fraud check (Steadfast history)                         | Owner to decide (M35); default: not carried over                     |
| SSLCommerz, SMTP settings                               | ERP **Website → Payments, Email** (M34)                              |

## Order of work (changed on 2026-10-05, D-561, D-581, D-600)

1. M31 (one ERP per brand), M33 (website catalog and content) and M35a (discounts and flash
   sales) finish and are joined; M32 (the mother) is paused until the website is done.
2. **M38a** (product upload, stock in hand at cost, barcode stickers, the scanner), then Elysium's
   ERP goes live, fresh, at `erp.elysium-lifestyle.bd` on the current server.
3. M34 (buying) and M35b (landing pages, links, tracking, ncom, scanner app), then M36 (the
   website on the ERP, customers only imported) at `demo.elysium-lifestyle.bd`.
4. M38b (scan-to-pack and the packing video).
5. M32 resumes; M37 (domains switched, the mother's server).

## Order of work (as first planned)

1. M31 (brand edition) and M33 (website catalog and content) in parallel; M32 (mother) beside
   them, joining M31's owner link at the end.
2. M34 (buying) after M33; M35 (offers and integrations) after M33, priced into checkout once
   M34 lands.
3. M36 (website conversion and the old data) after M34 and M35.
4. M37 (servers and switch-over) with the owner, step by step.

## Problems found in the old site (2026-10-05)

1. **Fixed on a branch, not deployed:** the public `GET /api/admin/settings` returned the ncom
   connector and order secrets to anyone, and `GET /api/orders/[id]` returned the ncom block to
   shoppers. Fix: `D:\Projects\elysium` branch `fix/settings-public-allowlist` (66890cb). The
   ncom secrets should be rotated after deploying it.
2. Landing-page orders were numbered by counting and took stock without a check (could go
   negative); their stock was never returned on cancel. Replaced in M35.
3. SSLCommerz payments were never compared with the order total; no IPN. Fixed in M34.
4. One-time codes and reset tokens were stored in plain text. Hashed in M34.
5. Product edits overwrote stock with absolute numbers (a lost update under load). The ERP moves
   stock only through movements.
