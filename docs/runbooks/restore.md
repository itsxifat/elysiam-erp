# Backup and restore

How the database is backed up, how to get it back, and the drill that proves it (architecture
§25; M14b acceptance check 2). The decisions are D-342.

## What is backed up

| Copy                   | Where                              | Covers                             | Restore time       |
| ---------------------- | ---------------------------------- | ---------------------------------- | ------------------ |
| Point-in-time recovery | The managed provider               | Any second in the retention window | Provider's         |
| Nightly logical dump   | A second provider (not Cloudflare) | The database as of each night      | Minutes to an hour |
| R2 objects             | Cloudflare R2, versioning on       | Uploaded files, generated PDFs     | —                  |

PITR is the first resort: nothing is lost back to the moment chosen. The logical dump is
for losing the provider itself, or the account.

Nothing else holds state: Valkey keeps rate-limit counters and realtime channels only (it
restarts empty), and the VMs are rebuilt by `kamal setup`.

## The backup role

`pg_dump` cannot run as `erp_owner`. FORCE ROW LEVEL SECURITY binds the owner too (§5), and
pg_dump refuses a table whose rows a policy would filter ("query would be affected by
row-level security policy", verified on 17.11). A dump needs a role that bypasses RLS and
reads everything, and nothing more:

```sql
-- As an administrator that holds BYPASSRLS (or a superuser). PostgreSQL 16+ lets only a
-- role with BYPASSRLS create one.
create role erp_backup with login bypassrls password '<from the secret manager>';
grant pg_read_all_data to erp_backup;
grant connect on database elysium to erp_backup;
```

Check the admin first: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user;`.
If both are false, the provider must create the role, or the dump uses the provider's own
export tooling instead; record which in decisions.md (D-342 is open on this until the
provider is chosen).

`erp_backup` reads every brand's rows. Its password lives only in the backup runner's
secrets, never in the application's, and the role can write nothing.

## The nightly dump

On the `jobs` VM (or any machine that can reach the database), from cron, at 02:30
Asia/Dhaka:

```sh
#!/bin/sh
set -eu
STAMP=$(date -u +%Y%m%dT%H%MZ)
FILE=/var/backups/elysium/elysium-$STAMP.dump
docker run --rm -e PGPASSWORD="$ERP_BACKUP_PASSWORD" -v /var/backups/elysium:/out \
  postgres:17.11-alpine pg_dump --format=custom --no-owner \
  --host "$DB_HOST" --username erp_backup --dbname elysium --file "/out/$(basename "$FILE")"
age -r "$BACKUP_AGE_RECIPIENT" -o "$FILE.age" "$FILE" && rm "$FILE"   # encrypted at rest
rclone copy "$FILE.age" second-provider:elysium-backups/   # e.g. Backblaze B2, not Cloudflare
find /var/backups/elysium -name '*.age' -mtime +7 -delete
```

Keep 30 nightly copies at the second provider (a lifecycle rule there), and alert when a
night is missing (`monitoring.md`). The dump holds personal data: it is encrypted before it
leaves the VM, and the private key is held by the owner, not on any server.

## Restore from PITR

1. Provider console → the database → restore to a **new** instance at the chosen time
   (never over the live one). Note the start time.
2. On the new instance, the roles already exist (they are cluster-level and came with it).
   Check: `select rolname, rolsuper, rolbypassrls from pg_roles where rolname like 'erp_%';`.
3. Check the data (below), then point the environment at it: change the host in
   `<ENV>_DATABASE_URL`, `<ENV>_DATABASE_OWNER_URL` and `<ENV>_DATABASE_ANALYTICS_URL` in the
   secret manager and run `kamal redeploy $K` (Kamal writes the containers' environment at
   deploy time, so the new URLs take effect then).
4. `deploy.md` A.6. Note the end time.

## Restore from the logical dump

1. A fresh database on a reachable Postgres 17 (a new managed instance, or a scratch one for
   the drill), created by its admin user.
2. The three roles: `deploy.md` A.3's `bootstrap.js` step, against the new database.
3. The dump, as `erp_owner`, so `erp_owner` owns everything again:

   ```sh
   rclone copy second-provider:elysium-backups/elysium-<stamp>.dump.age .
   age -d -i <owner's key> -o elysium.dump elysium-<stamp>.dump.age
   docker run --rm -e PGPASSWORD="$OWNER_PASSWORD" -v "$PWD":/in postgres:17.11-alpine \
     pg_restore --no-owner --exit-on-error --single-transaction \
     --host <host> --username erp_owner --dbname elysium /in/elysium.dump
   ```

   Row-level security is switched on in the dump's post-data section, after the rows are
   loaded, so the owner can load them; FORCE applies again from then on.

4. Check the data (below), then point the environment at it as in PITR step 3.

## Checks after any restore

Run as `erp_backup` (it sees every brand) on the restored database:

```sql
-- every migration is there
select count(*) from drizzle.__drizzle_migrations;     -- = entries in packages/db/migrations/meta/_journal.json
-- the books balance, per brand
select org_id, sum(debit_poisha) - sum(credit_poisha) as off
from ledger.journal_lines group by org_id having sum(debit_poisha) <> sum(credit_poisha);   -- no rows
-- the counts the drill compares with the source at dump time
select 'orders', count(*) from sales.orders
union all select 'journals', count(*) from ledger.journals
union all select 'movements', count(*) from inventory.stock_movements
union all select 'users', count(*) from iam.users;
```

And as `erp_app`, with no org set, a tenant table must read empty (RLS is live):
`select count(*) from sales.orders;` → 0.

## Drill log (acceptance check 2)

Before go-live, on staging, at least once per restore path. Write down the clock times:
how long the provider took, how long the checks took, and the data window lost.

| Date | Path (PITR / dump) | Restore point | Started | Database ready | Checks passed | Total | Data lost | By  |
| ---- | ------------------ | ------------- | ------- | -------------- | ------------- | ----- | --------- | --- |
|      |                    |               |         |                |               |       |           |     |

Not yet executed on staging: there is no staging environment until the owner supplies one
(G3, D-348). The logical path's commands were rehearsed locally on a throwaway Postgres 17;
the result is in docs/plans/M14b.md's status.
