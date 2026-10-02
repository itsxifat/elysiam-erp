# Rollback

Putting the previous release back (architecture §28; M14b acceptance check 3). Code rolls
back; the database schema does not.

## What can and cannot be rolled back

- **The server (API and worker):** yes, to any of the last five releases still on the hosts
  (`retain_containers: 5`). Kamal starts the old image again; nothing is downloaded.
- **The SPAs:** yes, any earlier Pages deployment, from the dashboard.
- **Migrations: no.** They are forward-only (invariant 9) and the release step has already
  applied them. The old code runs on the new schema, which is safe only because every
  release keeps its migrations additive (`deploy.md` B.2). If a release's migration is the
  problem, the fix is a new migration in a new release, never a manual `drop`.
- **Data written by the bad release:** stays. Money is corrected with reversal journals,
  stock with movements (invariants 2 and 3), never by restoring a backup over live data. A
  restore (`restore.md`) is for losing the database, not for undoing a release.

## Decide

Roll back when the new release is worse than the last: `/health/ready` failing, an error
spike in Sentry, a broken core flow (order desk, booking, POS sale). Say so in the team
channel before starting, with the version you are leaving.

## Server

```sh
export K="-c infra/kamal/deploy.yml -d production"
kamal app version $K                 # what runs now
kamal app containers $K -q           # the versions still on the hosts
kamal rollback <previous-version> $K
```

`kamal rollback` stops the current containers and boots the previous version's image,
behind the same health check, so kamal-proxy keeps serving until the old API answers
`/health/ready`. It runs the `pre-deploy` hook too; the release step finds nothing to
migrate and the queues already exist, so it changes nothing (D-340).

If the version you want is no longer on the hosts, deploy it as a release instead:
`git checkout <sha>` and `kamal deploy $K` (its migrations are already applied, so the
release step is a no-op).

## SPAs

Cloudflare dashboard → Workers & Pages → the project → Deployments → the previous
production deployment → **Rollback to this deployment**. Do it for each app that changed.

## Verify

`deploy.md` A.6: `/health/live`, `/health/ready`, the worker's `ready`, a console sign-in,
and Sentry quiet for ten minutes. Then open a follow-up for the fix.

## Drill log (acceptance check 3)

Executed on staging before go-live: deploy a harmless release, roll back to the one before,
verify, deploy forward again. Record each run.

| Date | From → to version | `kamal rollback` took | Health green after | Forward again | Notes | By  |
| ---- | ----------------- | --------------------- | ------------------ | ------------- | ----- | --- |
|      |                   |                       |                    |               |       |     |

Not yet executed: there is no staging environment until the owner supplies one (G3, D-348).
