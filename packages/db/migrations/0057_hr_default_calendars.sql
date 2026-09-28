-- A working-day calendar for every org (M19; architecture §12, D-187).
--
-- §12 asks for "a working-day calendar per org", and payroll cannot compute a month
-- without one: the number of working days is what a monthly salary is divided across.
-- An org with no calendar would either refuse to run payroll or silently fall back to
-- "every day is a working day", and the second of those pays a full month's salary for a
-- month with four more working days in it than the office had.
--
-- So every org gets `STD`, Friday off, active, default. Friday alone rather than Friday
-- and Saturday because that is the single-day weekend most Dhaka retail and warehouse
-- operations run (D-187, ASSUMED); an org on a two-day weekend edits the row or adds its
-- own calendar, and `hr.employees.calendar_id` lets a showroom on a six-day week and a
-- head office on a five-day week coexist in one org.
--
-- Idempotent, like `pnpm db:seed`: re-running it changes nothing, and an org that has
-- already renamed or re-weekended its calendar keeps what it chose. `on conflict do
-- nothing` rather than `do update`, because overwriting an org's weekend on every deploy
-- would be a migration that silently changes payroll.
--
-- ## Why FORCE is lifted for the insert
--
-- `hr.work_calendars` has RLS ENABLE **and** FORCE from 0054, and FORCE is what makes the
-- table owner — `erp_owner`, the role running this migration — subject to the org policy
-- too. A cross-org insert cannot satisfy a policy that compares `org_id` to one
-- `app.org_id`, so FORCE is lifted for the one statement and restored immediately.
--
-- The obvious alternative was a `DO` block looping the orgs with
-- `perform set_config('app.org_id', o.id, true)` before each insert. It works in psql and
-- **silently inserts nothing** through the application's driver: a GUC set inside a
-- PL/pgSQL block does not reliably outlive the block, so the policy saw an empty
-- `app.org_id` and the `WITH CHECK` matched no row — which RLS reports by writing nothing
-- rather than by raising. Verified: fourteen tables created, zero calendars inserted, no
-- error. Failing closed is the right behaviour for a policy and the wrong behaviour for a
-- seed, so the seed stops pretending to have a tenant context and says what it is doing.
--
-- Lifting FORCE is safe here because it lasts for one statement inside one transaction,
-- and because `erp_app` is unaffected either way: it is not the owner, so the policy binds
-- it whatever FORCE says.
--
-- ## This is a backfill, not the only source of a calendar
--
-- Migrations run **before** the org seed — `pnpm db:migrate && pnpm db:seed`, and the test
-- harness does the same — so on a brand-new database `org.organizations` is empty when this
-- runs and it inserts nothing. That is correct for what it is: a backfill for the databases
-- that already have the five brands in them, which is every environment M19 is deployed to.
--
-- An org that appears after this migration gets its calendar from
-- `ensureDefaultCalendar()` in `hr.repository.ts`, which the payroll and calendar paths call
-- before they need one. Two sources for the same row, both idempotent, because the
-- alternative is a payroll run that refuses to compute on a brand created last week.
alter table "hr"."work_calendars" no force row level security;--> statement-breakpoint

insert into hr.work_calendars (org_id, code, name, weekly_off, is_default, is_active)
select o.id, 'STD', 'Standard (Friday off)', array[5]::smallint[], true, true
from org.organizations o
on conflict do nothing;--> statement-breakpoint

alter table "hr"."work_calendars" force row level security;
