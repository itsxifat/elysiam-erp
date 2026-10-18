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
                     api ─ worker ─ camera ─ postgres 17 ─ valkey ─ gotenberg
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
| Docker volume `erp-<slug>_camera-buffer`            | The IP cameras' rolling buffer (half an hour at most, M38c)    |
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

### The website's key and Site URL

The website signs every call with a site key (`ERP_SITE_KEY_ID`, `ERP_SITE_SECRET`). Issue it
on the server, in the brand's release container, and pipe it straight into the website's
root-only env file, so the secret is never displayed or copied (D-582). The example writes to
`/etc/elysium-web/demo.env`; use the website's own env file and a label that names it:

```sh
cd ~/erp-brands/current && ERP_RELEASE=$(basename "$(readlink -f .)") docker compose \
  -f infra/brand/docker-compose.brand.yml --env-file ~/erp-brands/brands/<slug>/.env.brand \
  run --rm --no-deps -T release node dist/main.admin.js website-key --label "<label>" \
  | sudo tee -a /etc/elysium-web/demo.env >/dev/null
```

- Stdout is exactly two lines, `ERP_SITE_KEY_ID=pk_…` and `ERP_SITE_SECRET=sk_…`. The key id is
  also printed on the terminal (stderr) for the record. `-T` keeps a terminal's carriage
  returns out of the file.
- `tee -a` appends: take an older pair of lines out of the file first, then restart the website
  so it reads the new one.
- The key is listed on Website → Connection like any other; revoke it there. If the pipe
  failed, the secret is gone: revoke that key and issue another.
- It refuses without `INTAKE_KEY_SECRET` (the brand's `BRAND_INTAKE_KEY_SECRET`), which every
  key is derived from.

Then the website's own address, which the emails' links, password-reset links and SSLCommerz's
return addresses are built from (Website → Settings → Site URL, `https://` only):

```sh
cd ~/erp-brands/current && ERP_RELEASE=$(basename "$(readlink -f .)") docker compose \
  -f infra/brand/docker-compose.brand.yml --env-file ~/erp-brands/brands/<slug>/.env.brand \
  run --rm --no-deps -T release node dist/main.admin.js website-site-url \
  --url https://<website host>
```

It prints the saved address. Both commands act for the deployment's brand (`ERP_BRAND_SLUG`),
are audited as `system:admin-cli` with `via: 'cli'`, and refuse unless the database holds
exactly that one brand.

**Ask staff to reload Website → Settings afterwards.** The form keeps the site details it
loaded, and its Save sends the whole Site details section, so a page opened before the
command and saved after it puts the old Site URL back, emptying the emails' links without a
word. Reload the page, check the Site URL is the new one, and look again after anyone saves
the site details that day.

### The old `/admin` path

Its old `/admin` path should land on the ERP (D-475): paste the two locations from
`infra/brand/nginx-website-admin-redirect.conf` into the website's nginx `server` block,
replacing `__ADMIN_HOST__`, then `sudo nginx -t && sudo systemctl reload nginx`. Do this once
the brand's staff work in the ERP (the website's own panel retires with M36).

### Packing video uploads (M38b)

A brand whose nginx site was installed before M38b needs one hand patch, because the template
is installed once and certbot edits it: copy the `location = /v1/files/content { … }` block from
`infra/brand/nginx-brand.conf` into `/etc/nginx/sites-available/erp-<slug>.conf` (both the
`listen 443` server and any plain one), replacing `__ID__` with the brand's id as the other
blocks there have it, then `sudo nginx -t && sudo systemctl reload nginx`. Without it a packing
video over 25 MB is refused with 413 and stays queued in the browser.

### IP cameras at the packing tables (M38c)

The `camera` service (`node dist/main.camera.js`, the same image) records each IP camera
entered in the brand's Orders → Pack → Settings → IP cameras with ffmpeg, keeps at most half an
hour of each in the `camera-buffer` volume, and cuts every packing's video from it (D-672,
D-676). It starts with the rest of the brand on every deploy and publishes nothing.

- **The camera must be reachable from the brand server**: the server and the camera on the same
  LAN (Elysiam: server 192.168.20.237, camera 192.168.20.111, RTSP on TCP 554). Check from the
  server with `dc <slug> exec camera node -e "require('net').connect(554,'192.168.20.111').on('connect',()=>{console.log('open');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(1)})"`.
  Enter the camera by its IP address (or a full host name): a one-word name, `localhost`,
  127.x, 169.254.x and the like are refused (D-679).
- **Its own network and environment** (D-678, D-679): the service sits on the compose network
  `camera` with Postgres only (it cannot reach Valkey, Gotenberg, the API or the worker) and is
  given only `DATABASE_URL` (as `erp_app`), the brand, the storefront sealing key, the files
  storage settings, Sentry and `CAMERA_BUFFER_DIR`; none of the brand's other secrets.
- **The password goes in the ERP, never in a file or a chat**: an org admin types the camera's
  user name and password into the settings, where it is sealed with the brand's
  `STOREFRONT_CREDENTIALS_KEY` (which `new-brand.sh` writes). Nothing about a camera goes into
  `.env.brand`. Moving a camera to another host or port asks for the password again (D-677).
- **Where the password is on the server** (D-669): never on a command line. ffmpeg reads the
  address from a private list (mode 0600) in the camera's buffer directory, removed five seconds
  after ffmpeg started; after that it lives only in the camera process's and ffmpeg's memory.
  Root on the brand server can read that, as it can read `.env.brand`. Optional hardening, so
  that no other user of the host can see any process's details: mount `/proc` with
  `hidepid=2` (`sudo mount -o remount,hidepid=2 /proc`, and in `/etc/fstab`
  `proc /proc proc defaults,hidepid=2 0 0` to keep it after a reboot). Caveat: tools run by
  other users (and some monitoring agents) then see only their own processes; Docker and root
  are unaffected. Try it on a quiet hour and check `docker compose ps` and the monitoring still
  work.
- **Disk** (D-680): each camera's buffer is capped at 2 GiB (`CAMERA_BUFFER_MAX_BYTES`), and below
  5 GiB free under `/data/camera` (`CAMERA_MIN_FREE_BYTES`) the cameras stop and show "The
  server's disk is nearly full". Sizes: `stream1` (the full picture) is about 15 MB a minute, so
  about 450 MB of buffer a camera, and about 30 MB per two-minute packing kept in the files
  volume until seven days after delivery; `stream2` (the smaller picture) is about a tenth. At
  most eight cameras per brand.
- Its log names a camera by id and host, never its password: `dc <slug> logs --tail 100 camera`.
  "camera recording stopped" carries the reason (`auth_failed`, `unreachable`,
  `address_refused`, `disk_low`, …) the settings screen shows.
- The image carries ffmpeg (Debian's, about 470 MB of the image, D-675); `dc <slug> exec camera
ffmpeg -version` shows it.
- **The live view** (D-683): while a packing computer shows an IP camera, the camera service
  runs a second, light ffmpeg for it and writes one small JPEG to the `camera-preview` volume,
  which the API reads (read-only) for the Pack screen; it stops 20 s after nobody looks. The
  input lists with the passwords stay in `camera-buffer`. `dc <slug> logs camera` says "camera
  preview stopped" with the reason when one fails; the recording is not affected.

### Phone calls through Envo (M47)

Each brand has an Envo SIP server of its own: never point two brands' connections at one, or each
would import the other's calls and recordings (D-854). In Envo, for that SIP server:

1. Developers → API keys: a key with the read, calls and webphone scopes, and the brand's console
   (`https://<admin host>`) under allowed browser origins (without it the browser phone's session
   is refused). The package must include API access.
2. Each extension used in the browser has Web phone on.
3. Developers → Webhooks: the address Settings → Calls shows, events `call.started`,
   `call.answered` and `call.ended`; paste its signing secret into Settings → Calls.

The brand's `.env.brand` needs nothing for the owner's Envo. For another Envo, set
`BRAND_CSP_TELEPHONY_ORIGINS` (its https origin) and `BRAND_CSP_TELEPHONY_SOCKETS` (`wss://` and
its SIP domain), every host, space-separated, no quotes, and deploy (D-844). The API refuses a base
URL whose name resolves to a private address (D-830): check what the API container sees,
`dc <slug> exec -T api getent hosts envo.enfinito.cloud`, and if it is a LAN address set
`BRAND_TELEPHONY_ENVO_PRIVATE_CIDRS=<that address>/32`. `BRAND_TELEPHONY_ENVO_PROVIDER=fake` is
for a demo brand with no SIP server.

After deploying: Settings → Calls → Test lists the extensions; Envo's Send test shows HTTP 200 (a
403 means a Cloudflare bot check or WAF rule stands in front: skip it for `/webhooks/envo/*` on
the brand's zone and `/api/v1/*` on Envo's); `curl -sI https://<admin host>/ | grep -iE
'content-security-policy|permissions-policy'` shows `wss://call.enfinito.cloud` and
`microphone=(self)`; and an unsigned POST to the webhook address answers 401. Recordings are kept
365 days unless a connection says otherwise, beside Envo's own copy: check `df -h` before
switching recording on, or put the brand on R2 (D-842).

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
