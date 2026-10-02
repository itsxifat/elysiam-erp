# Preview server

The whole ERP on one rented Linux server, so people can open it in a browser and try it
before go-live (D-352). It is a preview, not production: one machine, its own Postgres in
Docker, no point-in-time recovery. Production is `deploy.md`.

What runs, all in Docker on one private network: Postgres 17, Valkey, Gotenberg, the API,
the worker, and Caddy. Caddy is the only thing reachable from outside: it serves the
console, portal and pos, passes `api.` to the API, and gets HTTPS certificates by itself.
Uploaded files stay on the server (a Docker volume) unless you give it Cloudflare R2.

## What you need

- A server: Ubuntu 24.04 LTS, 2 vCPU, **4 GB RAM** (8 GB is comfortable), 40 GB disk, a
  public IPv4 address, ports 80 and 443 open to the internet, and SSH access.
- Either a domain you control, or nothing: without one, the server's IP gets a free name
  from sslip.io (`203-0-113-5.sslip.io` always points to 203.0.113.5).

Login needs HTTPS: the session cookie is marked Secure, and browsers refuse such a cookie
over plain HTTP. So the preview is always served over HTTPS, on names, never on
`http://<IP>` (that address only redirects to the console).

## 1. Prepare the server (once)

Log in over SSH, then:

```sh
sudo apt-get update && sudo apt-get install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sudo sh        # Docker Engine and the compose plugin
sudo usermod -aG docker "$USER"                    # then log out and back in
docker compose version                             # should print v2.x
```

If the provider has a firewall, allow inbound TCP 22, 80 and 443 only.

## 2. Get the code

```sh
git clone <the repository URL> elysium && cd elysium
git checkout <the branch or tag to preview>
```

No git access on the server? Copy a checkout with `scp -r` or `rsync`, leaving out the
`node_modules` folders. Or build the two images on another machine that has Docker, with the
same `.env.preview` (the web image carries the domain), and move them across:
`docker save elysium-server:preview elysium-web:preview | ssh <server> docker load`; on the
server, start without `--build`. The server still needs this repository's `infra/` folder.

## 3. Choose the address

- **With a domain**, say `preview.example.com`: at your DNS provider, add an `A` record
  `*.preview.example.com` → the server's IP (a wildcard, so every name below resolves).
- **Without a domain**: nothing to do; use the server's IP in the next step.

## 4. Write the settings

```sh
sh infra/preview/init-env.sh preview.example.com      # or: sh infra/preview/init-env.sh 203.0.113.5
```

This writes `infra/preview/.env.preview` (never committed, readable by you only) with a
fresh random password or key for everything secret. Copy it somewhere safe: the database
passwords in it are written into the database the first time it starts, and the encryption
keys decide whether stored data can be read again. Open it to check `PREVIEW_DOMAIN`.

Optional lines in `.env.preview`:

- `PREVIEW_LOCAL_CERTS=local_certs` when the server cannot be reached from the internet:
  Caddy then signs its own certificates and browsers show a warning to click through.
- R2 instead of local file storage: `PREVIEW_STORAGE_DRIVER=r2`, the four `PREVIEW_R2_*`
  values (`deploy.md` A.2) and `PREVIEW_CSP_CONNECT_SRC=https://<account-id>.r2.cloudflarestorage.com`.
- `PREVIEW_SENTRY_DSN` to send errors to Sentry.

## 5. Start

Every command below is run from the repository folder, through this shorthand (put it in
`~/.bashrc` to keep it):

```sh
alias dcp='docker compose -f infra/docker-compose.preview.yml --env-file infra/preview/.env.preview'
```

The two images are built one after the other, which a 4 GB server needs:

```sh
dcp build release && dcp build caddy && dcp up -d
```

The first run builds two images (10–20 minutes on a small server), then:

1. Postgres starts, and the one-shot `release` service creates the three database roles,
   applies every migration, installs the job queues and loads the five brands and their
   charts of accounts (`db:seed`). It runs again, harmlessly, on every `up`.
2. The worker and the API start; Caddy starts once the API reports ready, and fetches its
   certificates (a minute on the first start).

Check:

```sh
dcp ps
curl -fsS https://api.<PREVIEW_DOMAIN>/health/ready
# {"status":"ok","checks":{"database":"ok","jobs":"ok","valkey":"ok"}}
```

## 6. Open it

| What              | Address                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Console           | `https://console.<PREVIEW_DOMAIN>`                                                                          |
| Brands' own login | `https://oura-lifestyle.<PREVIEW_DOMAIN>` (and `elysium-lifestyle-bd`, `orvo`, `wear-x-clothing`, `beownz`) |
| Portal            | `https://portal.<PREVIEW_DOMAIN>`                                                                           |
| Till              | `https://pos.<PREVIEW_DOMAIN>`                                                                              |
| API               | `https://api.<PREVIEW_DOMAIN>`                                                                              |

The database starts with the five brands and no people. Sign-in users are created
separately (demo data and demo users are their own task).

## Update to a newer version

```sh
git pull                       # or check out the new branch or tag
dcp build release && dcp build caddy && dcp up -d
```

The `release` service migrates the database before the new API and worker start. Data is
kept. Migrations only go forward, so going back to an older version on the same database
is not supported; start a fresh database instead (below).

## Look at logs

```sh
dcp logs -f api worker
dcp logs release
```

Phone numbers are masked and secrets never appear in these logs.

## Stop, start, start over

```sh
dcp stop    # stop, keep everything
dcp start   # start again
dcp down    # remove containers, keep data
```

To start over with an empty database (this deletes the preview's data and uploaded files):

```sh
dcp down -v
rm infra/preview/.env.preview && sh infra/preview/init-env.sh <domain or IP>
```

## If something is wrong

- `release` exited with an error: `logs release` shows why. A database password that no
  longer matches means `.env.preview` was regenerated over an existing database: restore
  the saved copy, or start over.
- No certificate: ports 80 and 443 must be reachable from the internet and the names must
  resolve to the server (`dig +short console.<PREVIEW_DOMAIN>`). Caddy retries by itself;
  `logs caddy` says what Let's Encrypt answered.
- The API is not ready: `curl -s https://api.<PREVIEW_DOMAIN>/health/ready` names the
  failing part (`database`, `jobs` or `valkey`); `logs api` says why.
