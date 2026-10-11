# Mother deploy: the owner console

How to put the mother ERP (M32, architecture §30) on its own server and connect it to the
brands. The brands never call it; it reads each brand's database read-only through an SSH
tunnel and signs the owner into a brand with a one-time link the brand checks with a public
key.

Two machines:

- **the mother server**: its own domain (say `owner.example.com`), Docker with Compose, nginx,
  certbot. It runs the Compose project `elysium-mother`: Postgres, the tunnel, the worker and
  the API, with the console's files served by nginx.
- **the brands server**: where every brand's ERP runs (`docs/runbooks/brand-deploy.md`). It
  gets one tunnel-only account and, per brand, a database port on 127.0.0.1.

**Not yet run on a server** (decisions.md, Unverified integrations): the first deploy is also the scripts' and the tunnel's first real run, so go step by step and check each.

Brands and the mother always deploy from **the same commit, brands first**: the mother reads a
brand only when the brand's migrations are exactly the ones its commit ships (D-481), and
shows `version_mismatch` otherwise.

## 1. The brands server's side (once)

1. Give each brand a reporting port: in `~/erp-brands/brands/<slug>/.env.brand` set
   `BRAND_REPORTING_DB_PORT=55xx` (one per brand, e.g. 5541, 5542, …). On the next deploy the
   brand's Postgres is published on `127.0.0.1:55xx` only (D-499). Deploy the brands from the
   commit the mother will run: `sh infra/brand/deploy.sh <user@brands> all <commit>`.
2. Make the tunnel account, with no shell:

   ```sh
   sudo adduser --system --group --shell /usr/sbin/nologin --home /home/mother-tunnel mother-tunnel
   sudo install -d -m 700 -o mother-tunnel -g mother-tunnel /home/mother-tunnel/.ssh
   ```

3. Install the mother's tunnel key (step 2.2 prints it) in
   `/home/mother-tunnel/.ssh/authorized_keys` (mode 600, owned by `mother-tunnel`), on one
   line, restricted to the mother's address and the brands' ports:

   ```
   from="<mother server IP>",restrict,port-forwarding,permitopen="127.0.0.1:5541",permitopen="127.0.0.1:5542" ssh-ed25519 AAAA… mother-tunnel@owner.example.com
   ```

4. Hold the account to forwarding in `/etc/ssh/sshd_config.d/mother-tunnel.conf`:

   ```
   Match User mother-tunnel
       AllowTcpForwarding local
       PermitOpen 127.0.0.1:5541 127.0.0.1:5542
       PermitTTY no
       X11Forwarding no
       AllowAgentForwarding no
       ForceCommand /usr/sbin/nologin
   ```

   Then `sudo sshd -t && sudo systemctl reload ssh`. Add a brand later by adding its port to
   both `permitopen` and `PermitOpen`.

## 2. The mother server (once)

1. DNS: `owner.example.com` → the mother server. If it is proxied by Cloudflare, use SSL mode
   Full (strict) once the certificate exists.
2. Unpack a release (the first `deploy.sh` run copies one to `~/mother/src/<sha>`, or
   `git archive` by hand) and write the settings and the tunnel key pair:

   ```sh
   sh infra/mother/new-env.sh owner.example.com <brands server host> ~/mother/.env.mother
   ```

   It refuses to overwrite: the file holds the database passwords and `MOTHER_SECRETS_KEY`,
   which opens every stored brand connection. **Back up `.env.mother` apart from the database
   dumps.** It prints the tunnel's public key (`~/mother/tunnel/id_ed25519.pub`) for step 1.3.

3. Set `MOTHER_TUNNEL_FORWARDS` in `.env.mother`: one `<listen>:<brand port>` pair per brand,
   e.g. `6541:5541 6542:5542`.
4. Record the brands server's host key, after checking its fingerprint:

   ```sh
   ssh-keyscan -t ed25519 <brands server host> > ~/mother/tunnel/known_hosts
   ```

## 3. Deploy

From a workstation at the repository root, the same commit as the brands:

```sh
MOTHER_SSH_KEY=~/.ssh/<key> sh infra/mother/deploy.sh <user@mother server> <commit>
```

`server-deploy.sh` checks the settings and tunnel files, builds `elysium-mother:<sha>` and
`elysium-mother-tunnel:<sha>`, runs the release step (`db-bootstrap`, then `migrate`), starts
the stack and waits for it to be healthy (a failed release leaves the running API untouched),
swaps the console's files in, installs the nginx site on the first deploy (rolled back if
`nginx -t` fails) and keeps the last three releases. On the first deploy, get the certificate:

```sh
sudo certbot --nginx -d owner.example.com
```

## 4. The first owner

```sh
cd ~/mother/src/<sha>
MOTHER_RELEASE=<sha> docker compose -p elysium-mother -f infra/mother/docker-compose.yml \
  --env-file ~/mother/.env.mother run --rm --no-deps release \
  node dist/main.cli.js bootstrap --email <address> --name "<full name>" \
  --public-url https://owner.example.com
```

It prints a one-time link. The owner sets a password and enrols two-step sign-in (required
for everyone, D-487), then invites the others from **People**.

## 5. Brands: add, re-point, re-key (on the server only)

Adding a brand, changing how the mother reaches it and making or replacing its owner sign-in
key are done **only here, on the mother's server**, with the CLI (D-690, D-700). The console
has no button for any of them and the API no route: a brand's database password is never
typed into a browser, and a stolen session cannot point the mother elsewhere or swap a key.
In the console, **Brands** can still rename a brand, change its staff console address, stop
reading it, test its connection and read it again.

Every command runs in the `release` container (the tunnel must be up for `test`):

```sh
cd ~/mother/src/<sha>
DC() {
  MOTHER_RELEASE=<sha> MOTHER_TUNNEL_DIR=$HOME/mother/tunnel docker compose \
    -p elysium-mother -f infra/mother/docker-compose.yml \
    --env-file ~/mother/.env.mother "$@"
}
```

The read connection is always the brand's `erp_analytics` role through the tunnel:

```
postgres://erp_analytics:<the brand's BRAND_DB_ANALYTICS_PASSWORD>@tunnel:<listen>/erp
```

Pass it in `MOTHER_BRAND_READ_URL`, read from the brand's `.env.brand` on the server, never
typed on a command line or pasted into a chat; the CLI prints only its fingerprint:

```sh
pw=$(grep '^BRAND_DB_ANALYTICS_PASSWORD=' ~/erp-brands/brands/<slug>/.env.brand | cut -d= -f2-)
export MOTHER_BRAND_READ_URL="postgres://erp_analytics:${pw}@tunnel:<listen>/erp"
```

- **List the brands:** `DC run --rm --no-deps release node dist/main.cli.js brands list`
  (slug, name, read or switched off, admin URL, connection and key fingerprints, last read,
  last error).
- **Add a brand** (the slug must equal the brand's `ERP_BRAND_SLUG`; the admin URL is
  `https://erp.<brand domain>`):

  ```sh
  DC run --rm --no-deps -e MOTHER_BRAND_READ_URL release node dist/main.cli.js \
    brands add --slug <slug> --name "<name>" --admin-url <url> </dev/null
  ```

  It refuses any user but `erp_analytics`, makes the owner sign-in key at once, prints the
  `OWNER_LINK_PUBLIC_KEY=` line and then the connection test, such as
  `Connection test: ok (version 139 of 139).` Put the line in the brand's `.env.brand` and
  redeploy that brand: "Open <brand> ERP" then signs the owner in there. A staging or
  restored copy of a brand needs its own key.

- **Change a brand's connection** (a new password, a new tunnel port):

  ```sh
  DC run --rm --no-deps -e MOTHER_BRAND_READ_URL release node dist/main.cli.js \
    brands set-connection --slug <slug> </dev/null
  ```

  It prints the new fingerprint and the connection test. The next pull uses it.

- **Make or replace a brand's owner sign-in key:**

  ```sh
  DC run --rm --no-deps release node dist/main.cli.js brands rotate-key --slug <slug> </dev/null
  ```

  Put the printed `OWNER_LINK_PUBLIC_KEY=` line in the brand's `.env.brand` (replacing the old
  one) and redeploy the brand. Until then, "Open <brand> ERP" is refused there.

- **Test a connection:** `… brands test --slug <slug>` prints the same result code as the
  console's **Test connection** (see §9).

Then `unset MOTHER_BRAND_READ_URL pw`. Every command is audited as `system:operator`
(`brand.added`, `brand.connection_changed`, `brand.owner_link_key.created` or `.rotated`,
`brand.connection_tested`). The worker pulls a new brand within 10 minutes (and nightly in
full); the overview shows it.

## 6. Every release

1. Deploy the brands: `sh infra/brand/deploy.sh <user@brands> all <commit>`.
2. Deploy the mother from the same commit.
3. Open the overview: every brand should show fresh figures, none `version_mismatch`.

## 7. Owners and the break-glass reset

- Each owner manages their own sign-in under **My account** (D-701 to D-705): name, password,
  moving two-step sign-in to a new phone, new recovery codes, and signing out other devices.
  Every change to how they sign in asks for the password and a code held now (the app's, or a
  recovery code). Two-step sign-in cannot be turned off. An owner who lost their phone but
  kept recovery codes signs in with one, moves to the new phone with another, and ticks "Also
  sign out my other devices".
- An owner who lost their authenticator and their recovery codes: another owner asks for the
  reset in **People**, and a third owner decides it (D-488).
- With fewer than three owners, or none able to sign in, on the mother server:

  ```sh
  MOTHER_RELEASE=<sha> docker compose -p elysium-mother -f infra/mother/docker-compose.yml \
    --env-file ~/mother/.env.mother run --rm --no-deps release \
    node dist/main.cli.js people reset-two-factor --email <address>
  ```

  It is audited. The owner enrols again at their next sign-in.

## 8. Backups

- Dump the mother's database daily (`docker exec elysium-mother-postgres-1 pg_dump …`). It holds
  people, the registry (sealed), pulled figures and the audit log; every figure can be pulled
  again from the brands.
- Keep `.env.mother` (above all `MOTHER_SECRETS_KEY`) and `~/mother/tunnel/` apart from the
  dumps: a dump without the key cannot open the brand connections, and that is the point.

## 9. Troubleshooting, by the error a brand shows

| Error               | Meaning                                    | Look at                                                                  |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `unreachable`       | The tunnel or the brand's Postgres is down | `docker logs elysium-mother-tunnel-1`; the brand's port and `permitopen` |
| `timeout`           | The brand answered too slowly              | The brands server's load; the next pull retries                          |
| `auth_failed`       | Wrong `erp_analytics` password             | The brand's `BRAND_DB_ANALYTICS_PASSWORD`; `brands set-connection` (§5)  |
| `database_missing`  | No database `erp` at that address          | The connection's database name and listen port                           |
| `permission_denied` | The brand lacks the reporting grants       | Deploy the brand from the mother's commit (migration 0131)               |
| `version_mismatch`  | The brand and the mother differ in commit  | Deploy both from one commit, brands first                                |
| `brand_not_found`   | No org with the registry's slug            | The registry slug against the brand's `ERP_BRAND_SLUG`                   |
| `training_org`      | The connection reaches the training org    | Point the connection at the brand's own database                         |
| `secrets_key`       | The stored connection cannot be opened     | `.env.mother`'s `MOTHER_SECRETS_KEY` is not the one it was sealed with   |
| `read_failed`       | Anything else; the last figures are kept   | The worker's logs (`docker logs elysium-mother-worker-1`)                |
