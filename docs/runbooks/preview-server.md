# Preview server

The whole ERP at **https://elyerp.enfinito.cloud**, on the owner's server, so people can try
it before go-live (D-352). It is a preview, not production: one machine, its own Postgres in
Docker, no point-in-time recovery. Production is `deploy.md`.

The server already runs other live sites. They must keep working, so the ERP adds exactly
two things to the host: Docker containers that listen on `127.0.0.1` only, and one nginx
site. Nothing else on the host changes.

## How it fits together

```
browser ── https://elyerp.enfinito.cloud ──> host nginx (80/443, certbot certificate)
                                              │
            /            console   ─┐         │  files from /var/www/elyerp/current/www
            /portal/     portal     ├─────────┤
            /pos/        till      ─┘         │
            /v1/  /api/auth/  /public/v1/     │  proxied to 127.0.0.1:3410
            /socket.io/  /health/  ───────────┘
                                              ▼
                          Docker (project elysium-preview, one private network)
                          api ─ worker ─ postgres 17 ─ valkey ─ gotenberg
                          + release (one-shot: database roles, migrations, job queues)
```

| Address                                           | What                                           |
| ------------------------------------------------- | ---------------------------------------------- |
| `https://elyerp.enfinito.cloud/`                  | Console (staff)                                |
| `https://elyerp.enfinito.cloud/portal/investor`   | Investor portal                                |
| `https://elyerp.enfinito.cloud/portal/track/orvo` | Public order tracking, one per brand slug      |
| `https://elyerp.enfinito.cloud/pos/`              | Till (installable; starts offline once loaded) |
| `https://elyerp.enfinito.cloud/health/ready`      | API readiness                                  |

Everything is on one origin, so the browser needs no CORS for the apps and one certificate
covers all of it. The brands' own login hosts (`orvo.<domain>`) are not served on the
preview; everyone signs in at the console's address.

What lives where on the server:

| Path                                     | What                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `~/elyerp/.env.preview`                  | Every password and key (written on the first deploy). **Back it up.**     |
| `~/elyerp/src/<commit>`                  | The last three releases' sources; `~/elyerp/current` is the live one      |
| `/var/www/elyerp/releases/<commit>`      | The last three SPA builds; `/var/www/elyerp/current` is the live one      |
| `/etc/nginx/sites-available/elyerp.conf` | The nginx site (from `infra/preview/nginx-elyerp.conf`; certbot edits it) |
| Docker volumes `elysium-preview_*`       | The database and uploaded files                                           |

Ground rules on this server:

- Touch no other site's nginx file and no other service. The ERP's file is `elyerp.conf`.
- The host's own PostgreSQL (port 5432) belongs to the other apps. The ERP never uses it; it
  has its own Postgres 17 in Docker, which publishes no port at all.
- Docker-published ports bypass ufw, so the ERP publishes one port, the API's, and only on
  `127.0.0.1:3410`. ufw needs no change: 80 and 443 are already open for nginx.
- Container logs are capped (5 × 20 MB per container).

## 1. Prepare the server (once)

On the server, as the deploy user (it needs sudo):

```sh
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx
sudo usermod -aG docker "$USER"          # then log out and back in
docker compose version && docker buildx version
```

`docker-buildx` is required: the images are built with BuildKit, and without it `docker
build` stops with "BuildKit is enabled but the buildx component is missing".

Check that nothing already uses the API's port: `ss -ltn | grep -c ':3410 '` prints `0`.
If it is taken, put another port in `PREVIEW_API_PORT` in `~/elyerp/.env.preview` after the
first deploy and in the `upstream` block of the nginx site, then deploy again.

The DNS record `elyerp.enfinito.cloud` → the server's address must exist (it does). If it is
ever proxied through Cloudflare, nginx sees Cloudflare's addresses as visitors; the per-IP
login limits would then need nginx's `real_ip` module set up first.

## 2. Deploy (from a workstation)

From the repository root, in Git Bash on Windows or any POSIX shell with git, ssh and scp:

```sh
PREVIEW_SSH_KEY=~/.ssh/<key> sh infra/preview/deploy.sh <user>@<server> [commit]
```

The commit defaults to `HEAD`; uncommitted changes are never deployed. The script:

1. packages the commit with `git archive` and copies it to `~/elyerp/src/` over SSH;
2. on the first run, writes `~/elyerp/.env.preview` with fresh random secrets
   (`infra/preview/init-env.sh`; sh and openssl only);
3. builds the server image (the first build takes several minutes; later ones reuse the
   cache);
4. runs the **release step** before anything is replaced: creates or resets the three
   database roles (`erp_owner`, `erp_app`, `erp_analytics`), applies every new migration,
   installs the job queues. If it fails, the running API and worker are left untouched;
5. on an empty database only, runs the **seed** (the five brands, their branches and charts
   of accounts). It resets brand names and system accounts to the template's, so it does
   not run on later deploys; `PREVIEW_SEED=yes` before the command forces it;
6. starts or replaces the API and worker and waits until they are healthy;
7. builds the console, portal and till under `/`, `/portal/` and `/pos/` with the API on the
   same origin, with the same CSP as Cloudflare Pages, and switches
   `/var/www/elyerp/current` to them in one step;
8. installs the nginx site on the first run only, then `nginx -t` and a reload;
9. keeps the last three releases and removes older ones and unused images.

Other settings: `PREVIEW_DOMAIN` (default `elyerp.enfinito.cloud`) and `PREVIEW_REMOTE_DIR`
(default `elyerp`).

## 3. HTTPS (first deploy only)

The first deploy ends by printing this. On the server:

```sh
sudo certbot --nginx -d elyerp.enfinito.cloud
```

certbot adds the 443 block and the HTTP → HTTPS redirect to `elyerp.conf` and renews the
certificate by itself, like the other sites'. Sign-in works only after this: the session
cookie is `Secure`, and browsers drop it over plain HTTP.

## 4. Check

```sh
curl -fsS https://elyerp.enfinito.cloud/health/ready
# {"status":"ok","checks":{"database":"ok","jobs":"ok","valkey":"ok"}}
curl -sI https://elyerp.enfinito.cloud/ | grep -i content-security-policy
curl -sI https://elyerp.enfinito.cloud/pos/ | grep -i content-security-policy
```

Then open the console; the browser's developer console should show no CSP violation.

Who can sign in: the database starts with the five brands and no people. Self-service
sign-up is off by design (D-057), so the first users are created separately; that is its own
task, not part of a deploy.

## Day to day

On the server, a shorthand for the live release's stack (put it in `~/.bashrc`):

```sh
alias dcp='docker compose -f ~/elyerp/current/infra/docker-compose.preview.yml --env-file ~/elyerp/.env.preview'
```

```sh
dcp ps                         # what runs; api and postgres should say (healthy)
dcp logs -f --tail 100 api worker
dcp logs release               # the last release step
dcp restart api worker
dcp exec postgres psql -U postgres -d elysium     # a database shell (superuser)
```

Phone numbers are masked and secrets never appear in the logs.

**Update**: deploy a newer commit (section 2). Data is kept. Migrations only go forward, so
deploying an older commit is safe only when no migration was added since; otherwise restore
a backup or start over.

**Back up** (both, together):

```sh
cp ~/elyerp/.env.preview ~/elyerp/env-preview.backup && chmod 600 ~/elyerp/env-preview.backup
dcp exec -T postgres pg_dump -U postgres -Fc elysium > ~/elyerp/elysium-$(date +%F).dump
```

Keep a copy of `.env.preview` off the server too: without its keys, encrypted fields (staff
records, courier and marketing credentials) cannot be read back, and without its database
passwords the stack cannot reach its own data.

**Stop and start**: `dcp stop` / `dcp start`. nginx answers 502 for the API while it is down;
the SPAs' files are still served.

**Start over with an empty database** (deletes the preview's data and uploaded files):

```sh
dcp down -v && rm ~/elyerp/.env.preview
```

then deploy again; the first-deploy steps run again (except the nginx site and certificate,
which stay).

**Remove the preview entirely**:

```sh
dcp down -v --rmi all
sudo rm /etc/nginx/sites-enabled/elyerp.conf /etc/nginx/sites-available/elyerp.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name elyerp.enfinito.cloud
sudo rm -rf /var/www/elyerp && rm -rf ~/elyerp
```

## Settings in `~/elyerp/.env.preview`

Written once by `init-env.sh` from `infra/preview/.env.preview.example`, which explains every
line. Never regenerate it over an existing database. Optional lines:

- R2 instead of files on the server: `PREVIEW_STORAGE_DRIVER=r2`, the four `PREVIEW_R2_*`
  values (`deploy.md` A.2) and `PREVIEW_CSP_CONNECT_SRC=https://<account-id>.r2.cloudflarestorage.com`.
- `PREVIEW_SENTRY_DSN` to send errors to Sentry.

A changed setting takes effect on the next deploy.

## If something is wrong

- The deploy stops at "checks": the message names the package to install or the group to
  join.
- The release step fails: `dcp logs release`. "password authentication failed" means
  `.env.preview` was replaced while the database was kept: restore the backup copy, or start
  over.
- `502 Bad Gateway` on `/v1/...` or `/health/...`: the API is down or not ready. `dcp ps`,
  then `dcp logs api`; `curl -s http://127.0.0.1:3410/health/ready` names the failing part
  (`database`, `jobs` or `valkey`).
- Sign-in does nothing: the page is on `http://`, or certbot has not run (section 3).
- A newer `infra/preview/nginx-elyerp.conf`: deploys never overwrite the installed site,
  because certbot edited it. Compare and apply the change by hand, then
  `sudo nginx -t && sudo systemctl reload nginx`.
