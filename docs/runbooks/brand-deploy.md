# Brand deploy: one ERP per brand

Every brand runs its own copy of the ERP on the brands server (D-469, D-474): its own
Docker Compose project `erp-<slug>` with its own Postgres 17, Valkey, Gotenberg, API, worker
and files volume, its own `.env.brand`, its own nginx site and certificate, and its own
loopback port. All brands run the same code from the same commit. Nothing in one brand's
project can reach another's, and nothing a brand's staff, shoppers or website developer sees
names another brand (D-472).

This runbook sets up and deploys brands. It deploys nothing by itself: every step below is
run by a person, on purpose. The mother ERP has its own server and its own runbook (M32).

## How it fits together

```
staff browser ── https://admin.<brand domain> ──> host nginx (80/443, one certificate per host)
                                                   │
       /            console   ─┐                   │  files from /var/www/erp-<slug>/current/www
       /portal/     portal     ├───────────────────┤
       /pos/        till      ─┘                   │
       /v1/ /api/auth/ /public/v1/ /storefront/    │  proxied to 127.0.0.1:<the brand's port>
       /media/ /socket.io/ /health/  ──────────────┘
                                                   ▼
                     Docker project erp-<slug> (one private network per brand)
                     api ─ worker ─ postgres 17 ─ valkey ─ gotenberg
                     + release (one-shot: roles, migrations, job queues; the seed once)

website ── https://<brand domain> ── its own server; `/admin` redirects to the admin host
```

| Path on the server                                  | What                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `~/erp-brands/brands/<slug>/.env.brand`             | The brand's passwords and keys (new-brand.sh). **Back it up.** |
| `~/erp-brands/src/<commit>`                         | The last three releases' sources                               |
| `/var/www/erp-<slug>/releases/<commit>`             | The brand's last three SPA builds; `current` is the live one   |
| `/etc/nginx/sites-available/erp-<slug>.conf`        | The brand's nginx site (from `infra/brand/nginx-brand.conf`)   |
| Docker volumes `erp-<slug>_postgres-data`, `_files` | The brand's database and uploaded files                        |
| Docker image `erp-server:<commit>`                  | The server image every brand runs, built once per deploy       |

Ground rules:

- Each brand's API publishes one port, on `127.0.0.1` only (from 3501 up, one per brand).
  Postgres, Valkey and Gotenberg publish nothing. Docker-published ports bypass ufw, which is
  why nothing else is published.
- One brand's `.env.brand` holds that brand's secrets only. Never copy one brand's file to
  another: the database passwords are inside that brand's volume.
- The admin host is `admin.<brand domain>` by default (D-475). Cookies are scoped to the admin
  host alone (`APP_DOMAIN`), so the brand's website on the parent domain never receives them.

## 1. Prepare the server (once)

As in `preview-server.md` §1: Docker with Compose and buildx, the deploy user in the `docker`
group, nginx, certbot and curl. Then pull this repository's `infra/brand` folder onto the
server (the first `deploy.sh` run copies a whole release; `new-brand.sh` can also be run from
there).

## 2. Set up a brand (once per brand)

1. Point DNS: `admin.<brand domain>` → the brands server (an A record).
2. On the server, write the brand's settings with fresh secrets:

   ```sh
   sh infra/brand/new-brand.sh oura-lifestyle admin.ouralifestyle.com
   ```

   The slug must be one the seed knows (`packages/db/src/seed/orgs.ts`); the first deploy
   seeds that brand alone into its own database (`db:seed --brand <slug>`, D-470). A sixth
   brand needs its seed entry first. The API port is the next free one from 3501, or
   `--port <n>`. The file is `~/erp-brands/brands/<slug>/.env.brand`, mode 600.

3. Back the file up somewhere safe. Losing it means losing the database passwords.

4. Optional, when the mother ERP is ready (M32): paste its owner-link public key into
   `OWNER_LINK_PUBLIC_KEY` (base64 of an Ed25519 public key in SPKI DER). Empty keeps owner
   sign-in links off (`POST /v1/auth/owner-link` answers 404). Only the public key ever lives
   on a brand. A link names its brand by slug, so a staging, preview or restored copy of a
   brand must use a **different key pair** from production, or a production link would open
   it too (single use is per database).

5. If the admin host is proxied by **Cloudflare** (an orange-cloud DNS record), set
   `BRAND_BEHIND_CLOUDFLARE=true` in the brand's `.env.brand` before its first deploy (D-580).
   nginx then takes the visitor's address from `CF-Connecting-IP`, trusted only from
   Cloudflare's published ranges (`infra/brand/nginx-cloudflare-realip.conf`, refreshed on
   every deploy); without it every visitor shares Cloudflare's addresses in the API's rate
   limits and the audit log. Cloudflare's SSL/TLS mode must be **Full (strict)** once the
   certificate below exists: "Flexible" makes Cloudflare call the server over plain HTTP, and
   certbot's redirect would then loop.

## 3. Deploy

From a workstation, at the repository root, with the commit to deploy:

```sh
sh infra/brand/deploy.sh deploy@brands.example oura-lifestyle      # one brand
sh infra/brand/deploy.sh deploy@brands.example all                 # every brand set up
```

`BRAND_SSH_KEY=~/.ssh/<key>` picks the key; `ERP_BRANDS_DIR` moves `~/erp-brands`. For each
brand, `server-deploy.sh`:

1. builds the server image `erp-server:<commit>` (once for the whole run);
2. runs the brand's release step: the database roles, the migrations as `erp_owner`, the job
   queues;
3. on a database with no brand yet, seeds that brand alone: its chart of accounts, head
   office, hand-cash wallet and delivery zones;
4. starts the brand's API and worker. **Both refuse to start** if the database holds any other
   real brand (`ERP_BRAND_SLUG`, D-470); the logs say which;
5. builds the brand's console, portal and till with its admin host as the API address, and
   swaps them in;
6. on the first deploy, installs the brand's nginx site from the template; then `nginx -t`
   and a reload (a rejected configuration is rolled back).

On a brand's first deploy, get its certificate once:

```sh
sudo certbot --nginx -d admin.ouralifestyle.com
```

## 4. The brand's first admin

With no owner link yet, make the brand's first super admin on the server and hand them the
one-time link it prints (valid 72 hours):

```sh
cd ~/erp-brands/current
ERP_RELEASE=$(basename "$(readlink -f .)") docker compose -f infra/brand/docker-compose.brand.yml \
  --env-file ../brands/<slug>/.env.brand run --rm --no-deps release \
  node dist/main.admin.js bootstrap --email <address> --name "<full name>" \
  --console-url https://admin.<brand domain>
```

It refuses once a super admin (other than an owner) exists. Owners arriving by owner sign-in
link need nothing here: the link makes their identity on its first use.

## 5. The brand's website

The website calls the brand's ERP from its own server: the order intake (`/public/v1`,
`docs/public-api.md`) and, from M33, the storefront (`/storefront`) and images (`/media`), all
at `https://admin.<brand domain>`.

Its old `/admin` path should land on the ERP (D-475): paste the two locations from
`infra/brand/nginx-website-admin-redirect.conf` into the website's nginx `server` block,
replacing `__ADMIN_HOST__`, then `sudo nginx -t && sudo systemctl reload nginx`. Do this once
the brand's staff work in the ERP (the website's own panel retires with M36).

## 6. Operating a brand

```sh
dc() {
  slug=$1
  shift
  ERP_RELEASE=$(basename "$(readlink -f ~/erp-brands/current)") \
    docker compose -f ~/erp-brands/current/infra/brand/docker-compose.brand.yml \
    --env-file ~/erp-brands/brands/"$slug"/.env.brand "$@"
}
dc oura-lifestyle ps
dc oura-lifestyle logs --tail 100 api worker
dc oura-lifestyle restart api
```

- Rollback: deploy the previous commit (`deploy.sh … <slug> <commit>`); migrations are
  forward-only (invariant 9), so a rollback past a migration is a restore (`restore.md`).
- Backups: one `pg_dump` per brand database (`restore.md`), and the brand's `.env.brand`.
- Old server images: `docker image prune -a` removes the ones no brand runs.
- Shutting an owner out of one brand (the Staff screen does not list owners): new links stop
  when `OWNER_LINK_PUBLIC_KEY` is emptied and the API restarted; sessions already open last
  up to two hours, so end them too, as the owner role:

  ```sh
  dc <slug> exec -T postgres psql -U postgres -d erp -c     "update iam.users set is_active = false where is_owner and email = '<owner email>';
     delete from iam.sessions s using iam.users u where s.user_id = u.id and u.email = '<owner email>';"
  ```

  A switched-off owner's next link is refused (`identity_inactive` in the API's log).

## Checks

- `curl -fsS http://127.0.0.1:<port>/health/ready` on the server answers for each brand.
- A brand's console names only that brand; `pnpm check:white-label` keeps the shipped files
  free of every brand's name (M31 check 3).
- `docker compose ls` shows one `erp-<slug>` project per brand and nothing shared between
  them but the image.
