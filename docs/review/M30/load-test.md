# Load test (M30 check 1)

§29's targets, measured with k6 on 2026-10-02 at commit `0294617` by `pnpm load:test` (D-361).
Later M30 commits changed both measured paths: order save gained the discount ceiling (one
catalogue read per save) and the intake an area lookup. Both are one indexed query and the
margins below are wide, but re-run the test before go-live on the commit being deployed.
The raw k6 summaries are beside this file: `k6-order-desk-summary.json` and
`k6-intake-summary.json`.

**Verdict:** every target measured here is met with a wide margin. The two §29 rows that a
local run cannot measure honestly have a plan below, as check 1 allows.

## Results

| §29 row                                                     | Target       | Samples | Median  | p95     | p99      | Errors | Verdict  |
| ----------------------------------------------------------- | ------------ | ------- | ------- | ------- | -------- | ------ | -------- |
| Order desk customer lookup (the fraud badge removed, D-291) | p95 < 300 ms | 601     | 27.0 ms | 37.4 ms | 45.2 ms  | 0.00%  | **met**  |
| SKU search, 20,000 SKUs                                     | p95 < 200 ms | 601     | 27.0 ms | 37.1 ms | 43.9 ms  | 0.00%  | **met**  |
| Order save                                                  | p95 < 400 ms | 301     | 62.6 ms | 83.2 ms | 102.5 ms | 0.00%  | **met**  |
| Public intake API at 20 req/s sustained                     | p95 < 500 ms | 1,201   | 52.3 ms | 74.4 ms | 85.2 ms  | 0.00%  | **met**  |
| Stock availability (no §29 row)                             | —            | 301     | 30.5 ms | 42.2 ms | 58.2 ms  | 0.00%  | reported |
| Order queue, 25 rows (no §29 row)                           | —            | 121     | 28.4 ms | 39.9 ms | 56.8 ms  | 0.00%  | reported |
| Reports over 12 months of one org                           | p95 < 3 s    | —       | —       | —       | —        | —      | plan     |
| Console first load                                          | < 2.5 s, 4G  | —       | —       | —       | —        | —      | plan     |

## How it was run

- **Machine:** AMD Ryzen 5 5600G (12 threads), 15 GB, Windows 11, Node 24.21.0. The API,
  the worker, Postgres 17, Valkey and k6 all shared it. These figures are an upper bound on
  production's server-side latency, not a production figure.
- **Data:** a throwaway database at §29's sizes: 20,000 SKUs (2,000 products × 10, with
  varied names and codes, so the trigram indexes answer the real question), every SKU in
  stock, and 5,000 buyers with addresses. It was dropped at the end. The preview server and
  `elysium_dev` were never touched (D-361).
- **Stack:** the built API and worker (`apps/server/dist`) on their own port, signed in
  through Better Auth's real endpoints as four sales agents. The intake site key was issued
  through `POST /v1/intake/site-keys`. k6 ran in `grafana/k6`.
- **Order desk:** each call at its own constant arrival rate for 60 s, after a 15 s warm-up
  that the thresholds exclude: lookup 10/s, SKU search 10/s, order save 5/s, availability
  5/s, queue 2/s (about 29 requests a second together). That is several busy desks at once
  on one brand. Lookups are 80% existing buyers. Saves carry 1–3 lines and a new or
  returning buyer.
- **Intake:** 20 signed orders a second for 60 s. Each order has a fresh idempotency key,
  buyer phone and visitor IP, and an HMAC over the raw body exactly as `docs/public-api.md`
  says. The intake's per-source and per-site limits were raised for the run, because one k6
  container is every visitor and every server. Turnstile's real client made a real HTTP call
  to a local stand-in.
- **No iterations were dropped:** k6 kept every arrival rate.

## What the local numbers leave out

- **Turnstile's round trip to Cloudflare.** Every intake order makes one siteverify call,
  which adds one network round trip from the server to Cloudflare on top of the figure
  above. It was not measured here. `INTAKE_TURNSTILE_TIMEOUT_MS` caps it at 3 s, and past
  the cap the order is answered 503 and the site retries with the same key. With 425 ms of
  headroom under the target, a slow siteverify is the first thing to check if the intake's
  p95 rises in production.
- **The network between a Bangladeshi browser and the server.** §29's targets are
  server-side; the desk adds its own round trip.
- **A first run of the harness** measured the intake at 100% errors. That was the runner's
  bug, not the API's: the Turnstile stand-in shared a process with a blocking `spawnSync`.
  It is fixed in `scripts/load-test.mjs`, and the table above is the re-run.

## The two rows not measured here, and the plan

- **Reports over 12 months (p95 < 3 s, rollups):** a local run would time an empty year.
  M24's dashboards read the `analytics.daily_org` rollups by design. The plan is part 2:
  - time the dashboard, P&L and balance sheet on staging, after the pilot brand's data
    migration (M14a), and again after its first full month;
  - for a full year before that, seed twelve months of rollups into a throwaway database
    with a bench beside `catalog-search.bench.mjs`.
- **Console first load (< 2.5 s on 4G):**
  - the bundle half is enforced on every `pnpm verify`: 240.7 KB of 250 KB gzipped at the
    last full run;
  - the 4G half needs the real CDN in front. The plan is a throttled Lighthouse run against
    staging in part 2 (Slow 4G, cold cache, first route), recorded here.

## Re-running it

`pnpm load:test` (or `pnpm load:test desk` / `pnpm load:test intake`). Build the server first, with
Docker and the dev stack running, under the machine's heavy lock. It needs nothing else and
cleans up after itself. Never point it at the preview server or any shared host: they run
other people's live apps.
