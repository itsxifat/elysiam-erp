# Secret rotation

How each secret is changed, what changing it breaks, and how to tell it worked
(architecture §25). Secrets live in the secret manager under an `<ENV>_` prefix and reach
the containers through `infra/kamal/secrets.<env>` at deploy time (`deploy.md` A.4).

The general move is the same for every row below: put the new value in the secret manager,
then `kamal redeploy $K` (it rewrites the containers' environment and restarts behind the
health check), then verify. Rotate on staging first.

**When:** on a schedule for the ones marked _routine_ (every 6 months, or when someone with
access leaves); at once, for any secret, on a suspected leak.

## Routine, no side effects

| Secret                                     | Steps                                                                                                                                               | Verify                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `KAMAL_REGISTRY_PASSWORD`                  | New registry token; update; revoke the old one after the next `kamal deploy` pulls                                                                  | `kamal registry login $K`             |
| `VALKEY_PASSWORD`, `VALKEY_URL`            | Update both together; `kamal accessory reboot valkey $K`, then `kamal redeploy $K` at once (counters and channels restart empty, which is harmless) | `/health/ready` says `valkey: ok`     |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | New token for the same bucket; update both; redeploy; delete the old token                                                                          | Upload a product image in the console |
| `TURNSTILE_SECRET_KEY`                     | Rotate the widget's secret in Cloudflare; update; redeploy                                                                                          | A test order through a landing form   |
| `CLOUDFLARE_ORIGIN_*_PEM`                  | New Origin CA certificate; update both; `kamal deploy $K` (the proxy loads it); revoke the old one                                                  | `/health/live` through Cloudflare     |
| `SENTRY_DSN`                               | New client key in the Sentry project; update; redeploy; disable the old key                                                                         | `monitoring.md` test event            |
| `OTEL_EXPORTER_OTLP_HEADERS`               | New collector token; update; redeploy                                                                                                               | Spans arrive at the collector         |

## Database passwords

One role at a time, so the application is never without a working login:

1. Generate the new password. As the provider's admin user:
   `alter role erp_app with password '<new>';` (PostgreSQL keeps open connections; only
   new ones need the new password).
2. Update `<ENV>_DATABASE_URL` at once, then `kamal redeploy $K`.
3. The same for `erp_analytics` (`DATABASE_ANALYTICS_URL`) and `erp_owner`
   (`DATABASE_OWNER_URL`, worker only), and for `erp_backup` in the backup runner.

Re-running `bootstrap.js` (`deploy.md` A.3) with the new URLs does the same for all three
at once; it is idempotent.

Verify: `/health/ready` (`database: ok`), the worker logs `ready`, and the next night's
dump succeeds.

## Signing and encryption keys: read before touching

These protect data at rest. Changing one without a re-encryption makes what it protected
unreadable. **Do not rotate them on a schedule.** Rotate on a leak, following the row.

| Secret                      | What it protects                                                                   | Rotating it today means                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`               | Session cookies, and Better Auth's encryption of every TOTP secret and backup code | Everyone is signed out **and every 2FA enrolment becomes unreadable**, so every second-factor check fails. There is no reset screen: each user's 2FA record must be cleared in the database before they can enrol again. Plan it as an incident: tell the brands, rotate, clear and re-enrol super admins first. Better Auth 1.7's versioned secrets would avoid this; they are not wired yet (follow-up). |
| `HR_FIELD_KEY`              | Employees' national ID, payout account and phone (M19)                             | Those fields become unreadable. There is no re-encryption tool yet (the format carries a version byte for one, follow-up). On a leak: export the fields with the old key first, rotate, re-enter them.                                                                                                                                                                                                     |
| `COURIER_CREDENTIALS_KEY`   | Each courier account's API keys and webhook secret                                 | Set `COURIER_CREDENTIALS_KEY_ID` to a new id with the new key; each brand re-enters its courier credentials in the console (old ones no longer open). Rotate the credentials at the courier too if they leaked.                                                                                                                                                                                            |
| `MARKETING_CREDENTIALS_KEY` | Each brand's Meta system-user token                                                | As courier: new key and `MARKETING_CREDENTIALS_KEY_ID`, then each brand saves its token again.                                                                                                                                                                                                                                                                                                             |
| `INTAKE_KEY_SECRET`         | The master every landing site's and website key's signing secret is derived from   | Every site's signing secret changes: re-issue each site key in the console and update each landing page before it can post orders again. The brand website's keys (Website → Connection, D-509) change too: issue a new one and update the website's server before it can read the catalog again.                                                                                                          |

Keep the previous value of each of these in the secret manager, marked retired, until the
rotation is verified: it is the only way back if a step was missed.

## Record

| Date | Environment | Secret | Reason (schedule / leak) | Verified | By  |
| ---- | ----------- | ------ | ------------------------ | -------- | --- |
|      |             |        |                          |          |     |
