# Deploy

How the ERP reaches staging and production, and how to tell that a release is healthy
(architecture §28, M14b). The release mechanics are D-340; the network and TLS are D-343.

| Piece                | Where it runs                                    | Defined in                       |
| -------------------- | ------------------------------------------------ | -------------------------------- |
| API, worker          | Docker on the VMs, one image, two commands       | `infra/docker/server.Dockerfile` |
| Valkey, Gotenberg    | Kamal accessories on the `web` VM                | `infra/kamal/deploy.yml`         |
| Postgres 17          | The managed provider (Singapore), with PITR      | this runbook, step 3             |
| console, portal, pos | Cloudflare Pages (static)                        | this runbook, step 7             |
| DNS, WAF, TLS, R2    | Cloudflare                                       | this runbook, step 2             |
| Migrations           | The release step, before any new container boots | `infra/kamal/hooks/pre-deploy`   |

Every command runs from the repository root, on a machine with Docker, Kamal 2.12+, Node
24 and pnpm 12. Every `kamal` command takes `-c infra/kamal/deploy.yml -d <staging|production>`;
below, `$K` stands for that pair:

```sh
export K="-c infra/kamal/deploy.yml -d staging"
```

---

## A. First-time provisioning

Do this once per environment, staging first. It is also the outline of what the owner
must supply (START-HERE.md gate G3).

### 1. Hosts

- Staging: one VM. Production: two (`web`: API, Valkey, Gotenberg; `jobs`: worker).
  Ubuntu LTS, 2 vCPU / 4 GB RAM at least on `web` (Gotenberg's Chromium is the hungry one).
  Singapore, the same region as the database. Not a shared agency server (§28).
- A deploy user with SSH key access and Docker installed (`kamal setup` installs Docker if
  it is missing and the user can `sudo`).
- Firewall, on every VM:
  - 22 from the operators' addresses only;
  - 80 and 443 from **Cloudflare's published IP ranges only**
    (`https://www.cloudflare.com/ips-v4`, `ips-v6`). This is what makes
    `TRUSTED_PROXY_COUNT=2` true: a visitor who reached the VM directly could otherwise
    write their own `X-Forwarded-For` and pick the IP the rate limits see (D-343);
  - 6379 on `web`'s private address from the `jobs` VM only (Valkey);
  - nothing else.
- Put the VMs' addresses in `infra/kamal/deploy.<env>.yml` (`servers`, `accessories.valkey`).

### 2. Cloudflare

- The zone for the parent domain (`APP_DOMAIN`).
- DNS, all proxied (orange cloud):
  - `api.<APP_DOMAIN>` → the `web` VM;
  - `console.`, `portal.`, `pos.` → their Pages projects (step 7);
  - one record per brand for branded login (D-035): `<slug>.<APP_DOMAIN>` → the console's
    Pages project. The slugs are `elysium-lifestyle-bd`, `oura-lifestyle`, `orvo`,
    `wear-x-clothing`, `beownz`. The API trusts exactly these origins and the three above.
- SSL/TLS mode **Full (strict)**. Create an **Origin CA certificate** for `api.<APP_DOMAIN>`
  (SSL/TLS → Origin Server) and store the certificate and key in the secret manager as
  `<ENV>_CLOUDFLARE_ORIGIN_CERT_PEM` and `<ENV>_CLOUDFLARE_ORIGIN_KEY_PEM`. kamal-proxy
  presents it; Cloudflare checks it.
- Always Use HTTPS on; HSTS on once staging has been verified (it is hard to undo).
- WAF managed rules on. A rate-limiting rule on `api.<APP_DOMAIN>/v1/intake*` is a cheap
  second layer over the API's own limits.
- R2: one bucket per environment (`elysium-staging`, `elysium-production`), and an API token
  scoped to that bucket with object read and write. Note the account id: the upload
  endpoint is `https://<account-id>.r2.cloudflarestorage.com` (step 7 needs it). If public
  product images are served from a custom domain, that is `R2_PUBLIC_BASE_URL`.

### 3. Managed Postgres and the three roles

- PostgreSQL 17, Singapore, **point-in-time recovery on** (§25), automated daily backups
  kept at least 7 days, and network access from the VMs (and the operator's address for
  this step) only.
- Create the database **as the provider's admin user**, so the admin owns it:
  `create database elysium;` (any name; the URLs below carry it).
- Generate three strong passwords and store the three URLs in the secret manager:

  ```
  <ENV>_DATABASE_OWNER_URL      postgres://erp_owner:<pw1>@<host>:5432/elysium?sslmode=require
  <ENV>_DATABASE_URL            postgres://erp_app:<pw2>@<host>:5432/elysium?sslmode=require
  <ENV>_DATABASE_ANALYTICS_URL  postgres://erp_analytics:<pw3>@<host>:5432/elysium?sslmode=require
  ```

  Use the provider's pooler-free (direct) host: pg-boss and the advisory locks need session
  semantics.

- Create the roles with the repository's `bootstrap.sql`, run by the admin user. It works
  without a superuser: CREATEROLE and owning the database are enough (D-341, proven by
  `packages/db/src/testing/managed-postgres.test.ts`). From the operator's machine, with the
  four URLs exported in the shell (never typed on the command line):

  ```sh
  docker build -f infra/docker/server.Dockerfile -t elysium-server .
  export DATABASE_ADMIN_URL=...        # the provider's admin user, this database
  export DATABASE_OWNER_URL=... DATABASE_URL=... DATABASE_ANALYTICS_URL=...
  docker run --rm -e DATABASE_ADMIN_URL -e DATABASE_OWNER_URL -e DATABASE_URL \
    -e DATABASE_ANALYTICS_URL elysium-server \
    node node_modules/@elysium/db/dist/cli/bootstrap.js
  unset DATABASE_ADMIN_URL
  ```

  It prints the three roles and refuses to finish if any can bypass row-level security.
  The admin URL is used for nothing else; do not put it in Kamal's secrets.

- Backups need one more role, `erp_backup`: `docs/runbooks/restore.md` § "The backup role".

### 4. Secrets

Each name in `infra/kamal/secrets.<env>` must exist, under its `<ENV>_` prefix, in the
operator's environment when Kamal runs (fill it from the secret manager, or replace the
line with a `kamal secrets fetch` adapter). Values never go into the repository.

| Secret                                                                 | How to make it                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| `KAMAL_REGISTRY_PASSWORD` (common)                                     | Registry token that can push and pull the image            |
| `DATABASE_URL`, `DATABASE_OWNER_URL`, `DATABASE_ANALYTICS_URL`         | Step 3                                                     |
| `VALKEY_PASSWORD`                                                      | `openssl rand -hex 32`                                     |
| `VALKEY_URL`                                                           | `redis://:<VALKEY_PASSWORD>@<web private ip>:6379`         |
| `AUTH_SECRET`                                                          | `openssl rand -base64 48`                                  |
| `HR_FIELD_KEY`, `COURIER_CREDENTIALS_KEY`, `MARKETING_CREDENTIALS_KEY` | `openssl rand -base64 32` each, all different              |
| `INTAKE_KEY_SECRET`                                                    | `openssl rand -base64 48`                                  |
| `TURNSTILE_SECRET_KEY`                                                 | Cloudflare Turnstile widget for the order forms            |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`            | Step 2                                                     |
| `CLOUDFLARE_ORIGIN_CERT_PEM`, `CLOUDFLARE_ORIGIN_KEY_PEM`              | Step 2                                                     |
| `SENTRY_DSN` (optional)                                                | A Sentry project per environment; empty means off (D-344)  |
| `OTEL_EXPORTER_OTLP_HEADERS` (optional)                                | The collector's auth header, e.g. `authorization=Bearer …` |

Keep a copy of `HR_FIELD_KEY`, `COURIER_CREDENTIALS_KEY` and `MARKETING_CREDENTIALS_KEY` in
a second place: losing one makes the rows it encrypted unreadable (`secret-rotation.md`).

Non-secret settings (hostnames, `TRUSTED_ORIGINS`, `R2_BUCKET`, `SENTRY_ENVIRONMENT`, an
`OTEL_EXPORTER_OTLP_ENDPOINT`) are in `infra/kamal/deploy.<env>.yml`.

### 5. First deploy

```sh
kamal setup $K        # Docker on the hosts, the accessories, then a full deploy
```

The deploy runs the release step (section B) before booting anything, so the schema and the
job queues exist before the API starts. Then seed the reference data and the five brands,
once:

```sh
kamal app exec $K --roles worker "node node_modules/@elysium/db/dist/cli/seed.js"
```

The seed is **not** a release step: it resets the names of the brands, their head office,
warehouse and system accounts to the template's. Run it again only when a release note
says so (it is how a brand gains a new system account, as M14a's `3350` did), and before
the go-live migration (`go-live.md`).

Create the first super admin with the invite flow from a trusted machine (D-057: the token
comes back in the response; there is no email yet), and enrol 2FA at once.

### 6. Verify the release (acceptance check 1)

```sh
curl -fsS https://api.<APP_DOMAIN>/health/live
curl -fsS https://api.<APP_DOMAIN>/health/ready
# {"status":"ok","checks":{"database":"ok","jobs":"ok","valkey":"ok"}}
kamal app logs $K --roles worker | grep -m1 '"msg":"ready"'
```

Also: `curl -sI https://console.<APP_DOMAIN>/ | grep -i content-security-policy` shows the
policy, the console signs in, and the browser's console shows no CSP violation.

Record it (check 1 is "the human confirms the URL"):

| Date | Environment | Version (`kamal app version`) | `/health/ready` | Console signs in | By  |
| ---- | ----------- | ----------------------------- | --------------- | ---------------- | --- |
|      |             |                               |                 |                  |     |

### 7. The SPAs on Cloudflare Pages

Direct upload with Wrangler (D-347): one Pages project per app per environment, built here
so the build gets this environment's API URL. A direct-upload project cannot later switch
to Git integration, which is fine: the build needs values from this runbook anyway.

```sh
export CLOUDFLARE_ACCOUNT_ID=...   CLOUDFLARE_API_TOKEN=...   # token: Account › Cloudflare Pages › Edit
npx wrangler pages project create elysium-console-staging --production-branch=main   # once per app
export VITE_API_URL=https://api.staging.elysium.example
export VITE_CSP_CONNECT_SRC=https://<r2-account-id>.r2.cloudflarestorage.com
pnpm --filter @elysium/console build
npx wrangler pages deploy apps/console/dist --project-name=elysium-console-staging --branch=main
```

Repeat for `portal` and `pos`. Each build writes `dist/_headers` (CSP, frame and sniffing
headers, asset caching), which Pages serves. Do not add a top-level `404.html`: without one,
Pages serves `index.html` for every route, which is what the routers need. Attach the custom
domains in the project (`console.`, the brand hostnames, `portal.`, `pos.`) and protect
preview deployments with Cloudflare Access.

---

## B. A routine release

1. `pnpm verify` is green on the commit (CLAUDE.md), and the commit is on `main`.
2. Read the release's migrations. A migration that drops or renames something the running
   version reads must wait for a later release (expand, then contract): the old containers
   keep serving while the release step runs, and a rollback runs old code on the new schema
   (`rollback.md`).
3. Deploy the server:

   ```sh
   kamal deploy $K
   ```

   Kamal builds and pushes the image, then the `pre-deploy` hook runs the release step from
   the new image (`node dist/main.release.js` in a one-off worker-role container: the
   migrations as `erp_owner` under an advisory lock, then the job queues). A failure stops
   the deploy with the old version still serving. Then the API containers boot, and
   kamal-proxy moves traffic only when `/health/ready` answers 200; then the worker.

   If the hook cannot run (`kamal app exec` refuses, for instance), the same step by hand:
   `kamal build push $K`, then
   `kamal app exec $K --roles worker --version <sha> "node dist/main.release.js"`, then
   `kamal deploy $K --skip-push --skip-hooks`.

4. Deploy the SPAs that changed (A.7). They talk only to `/v1`, so the order is: server
   first, SPAs after.
5. Verify (A.6) and watch the error tracker for ten minutes (`monitoring.md`).

Staging first, always; production the same day only after staging's checks pass.
