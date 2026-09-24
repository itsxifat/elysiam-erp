-- The ledger the database itself refuses to corrupt (architecture §7, M03).
--
-- 0013 (generated) holds the tables, keys and CHECKs. This file holds what
-- Drizzle cannot express, and every rule here is one a service could forget,
-- a job could skip, or a repair script could ignore:
--
--   1. isolation: RLS + FORCE + the generated org policy on all four tables,
--      and the minimum grants — journals and lines are INSERT + SELECT only;
--   2. balance: deferred constraint triggers, checked at commit, so a journal
--      with fewer than two lines or unequal sides cannot commit, however it
--      was written;
--   3. immutability: UPDATE and DELETE on journals and lines raise, for every
--      role, and a line can only be added by the transaction that created its
--      journal — otherwise a posted journal could grow a balanced pair of
--      extra lines months later and still pass the balance check;
--   4. the period lock: a journal dated in a closed period is refused, under
--      an advisory lock so a close can never interleave with a post;
--   5. periods: created by closing; open -> closed and closed -> open are the
--      only transitions, and closed -> open needs an approved period_reopen
--      for that period, raised and decided after the close (§6, §7, D-081).
--
-- Error messages start with a stable code (PERIOD_CLOSED, JOURNAL_UNBALANCED
-- …) that the ledger service maps to the API's error codes.

-- 1. Isolation. GENERATED from packages/db/src/rls.ts, like 0001, 0004, 0008.

--> statement-breakpoint
-- ledger.accounts: no DELETE. §7: orgs can add accounts but not delete system
-- ones, and an account with lines must never disappear from under them.
alter table "ledger"."accounts" enable row level security;
alter table "ledger"."accounts" force row level security;
drop policy if exists "accounts_org_isolation" on "ledger"."accounts";
create policy "accounts_org_isolation" on "ledger"."accounts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "ledger" to "erp_app", "erp_analytics";
grant select, insert, update on "ledger"."accounts" to "erp_app";
--> statement-breakpoint
-- ledger.journals: APPEND_ONLY.
alter table "ledger"."journals" enable row level security;
alter table "ledger"."journals" force row level security;
drop policy if exists "journals_org_isolation" on "ledger"."journals";
create policy "journals_org_isolation" on "ledger"."journals"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "ledger" to "erp_app", "erp_analytics";
grant select, insert on "ledger"."journals" to "erp_app";
--> statement-breakpoint
-- ledger.journal_lines: APPEND_ONLY.
alter table "ledger"."journal_lines" enable row level security;
alter table "ledger"."journal_lines" force row level security;
drop policy if exists "journal_lines_org_isolation" on "ledger"."journal_lines";
create policy "journal_lines_org_isolation" on "ledger"."journal_lines"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "ledger" to "erp_app", "erp_analytics";
grant select, insert on "ledger"."journal_lines" to "erp_app";
--> statement-breakpoint
-- ledger.periods: no DELETE. Deleting a closed period's row would reopen it
-- without anyone's approval.
alter table "ledger"."periods" enable row level security;
alter table "ledger"."periods" force row level security;
drop policy if exists "periods_org_isolation" on "ledger"."periods";
create policy "periods_org_isolation" on "ledger"."periods"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant usage on schema "ledger" to "erp_app", "erp_analytics";
grant select, insert, update on "ledger"."periods" to "erp_app";
--> statement-breakpoint

-- 2. Balance, checked at commit.
--
-- A constraint trigger on both tables: the one on journals catches a journal
-- inserted with no lines at all (no line trigger would ever fire for it), the
-- one on lines catches every line added. Row-level and deferred, so each
-- check sees the whole transaction's work. It reads through RLS as the
-- invoker; if the org context were changed mid-transaction the journal's lines
-- would vanish from view and the check would fail — closed, not open.
create or replace function ledger.assert_journal_balanced()
returns trigger
language plpgsql
as $$
declare
  v_journal uuid;
  v_lines integer;
  v_debit numeric;
  v_credit numeric;
begin
  if tg_table_name = 'journals' then
    v_journal := new.id;
  else
    v_journal := new.journal_id;
  end if;

  select count(*), coalesce(sum(debit_poisha), 0), coalesce(sum(credit_poisha), 0)
    into v_lines, v_debit, v_credit
    from ledger.journal_lines
   where journal_id = v_journal;

  if v_lines < 2 then
    raise exception 'JOURNAL_TOO_FEW_LINES: journal % has % line(s); a journal needs at least two',
      v_journal, v_lines
      using errcode = 'check_violation';
  end if;

  if v_debit <> v_credit then
    raise exception 'JOURNAL_UNBALANCED: journal % has debits of % and credits of % poisha',
      v_journal, v_debit, v_credit
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;
--> statement-breakpoint
drop trigger if exists journals_balanced on "ledger"."journals";
--> statement-breakpoint
create constraint trigger journals_balanced
  after insert on "ledger"."journals"
  deferrable initially deferred
  for each row execute function ledger.assert_journal_balanced();
--> statement-breakpoint
drop trigger if exists journal_lines_balanced on "ledger"."journal_lines";
--> statement-breakpoint
create constraint trigger journal_lines_balanced
  after insert on "ledger"."journal_lines"
  deferrable initially deferred
  for each row execute function ledger.assert_journal_balanced();
--> statement-breakpoint

-- 3. Immutability.
--
-- `erp_app` holds no UPDATE or DELETE grant (above), which is the control.
-- This trigger is for every other role, the owner included: invariant 2 says
-- journals never change after posting, not "never change unless you connect
-- as someone else". TRUNCATE is withheld by grant and asserted by the guard.
create or replace function ledger.refuse_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'LEDGER_IMMUTABLE: % rows are never updated or deleted; post a reversal journal instead',
    tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;
--> statement-breakpoint
drop trigger if exists journals_immutable on "ledger"."journals";
--> statement-breakpoint
create trigger journals_immutable
  before update or delete on "ledger"."journals"
  for each row execute function ledger.refuse_change();
--> statement-breakpoint
drop trigger if exists journal_lines_immutable on "ledger"."journal_lines";
--> statement-breakpoint
create trigger journal_lines_immutable
  before update or delete on "ledger"."journal_lines"
  for each row execute function ledger.refuse_change();
--> statement-breakpoint

-- 4. The period lock.
--
-- One advisory lock per (org, month). A post takes it shared, so posts never
-- wait for each other; a close or reopen takes it exclusive, so it waits for
-- every in-flight post of that month to commit or roll back, and every later
-- post waits for it. Without the lock a post could read "open", a close could
-- commit, and the post would then commit into the closed month.
create or replace function ledger.period_lock_key(p_org uuid, p_month date)
returns bigint
language sql
immutable
as $$
  select hashtextextended('ledger.period:' || p_org::text || ':' || p_month::text, 0)
$$;
--> statement-breakpoint
create or replace function ledger.before_journal_insert()
returns trigger
language plpgsql
as $$
declare
  v_month date := date_trunc('month', new.business_date)::date;
  v_status ledger.period_status;
begin
  -- Stamped here, never taken from the caller: this is what ties a journal's
  -- lines to the transaction that created it (see before_journal_line_insert).
  new.created_txid := pg_current_xact_id();

  -- Under REPEATABLE READ or SERIALIZABLE the status read below would come
  -- from the transaction's first snapshot, taken perhaps before a close
  -- committed, and the lock would protect nothing. Posting is READ COMMITTED.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'LEDGER_ISOLATION: journals must be posted under READ COMMITTED, not %',
      current_setting('transaction_isolation')
      using errcode = 'feature_not_supported';
  end if;

  perform pg_advisory_xact_lock_shared(ledger.period_lock_key(new.org_id, v_month));

  select status into v_status
    from ledger.periods
   where org_id = new.org_id and starts_on = v_month;

  if v_status = 'closed' then
    raise exception 'PERIOD_CLOSED: % falls in %, which is closed', new.business_date,
      to_char(v_month, 'YYYY-MM')
      using errcode = 'check_violation',
            hint = 'Reopening a period needs an approved period_reopen request.';
  end if;

  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists journals_before_insert on "ledger"."journals";
--> statement-breakpoint
create trigger journals_before_insert
  before insert on "ledger"."journals"
  for each row execute function ledger.before_journal_insert();
--> statement-breakpoint

-- Lines: same transaction as their journal, and consistent with their account.
create or replace function ledger.before_journal_line_insert()
returns trigger
language plpgsql
as $$
declare
  v_txid xid8;
  v_active boolean;
  v_party ledger.party_type;
  v_branch uuid;
begin
  select created_txid into v_txid
    from ledger.journals
   where id = new.journal_id and org_id = new.org_id;

  if v_txid is null then
    raise exception 'JOURNAL_LINE_INVALID: journal % does not exist', new.journal_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_txid <> pg_current_xact_id() then
    raise exception 'LEDGER_IMMUTABLE: journal % is already posted; lines cannot be added to it',
      new.journal_id
      using errcode = 'insufficient_privilege',
            hint = 'Post a new journal, or a reversal.';
  end if;

  select is_active, party_type, branch_id into v_active, v_party, v_branch
    from ledger.accounts
   where id = new.account_id and org_id = new.org_id;

  if v_active is null then
    raise exception 'LEDGER_ACCOUNT_INVALID: account % does not exist', new.account_id
      using errcode = 'foreign_key_violation';
  end if;

  if not v_active then
    raise exception 'LEDGER_ACCOUNT_INVALID: account % is inactive', new.account_id
      using errcode = 'check_violation';
  end if;

  if v_party is distinct from new.party_type then
    raise exception 'JOURNAL_LINE_INVALID: account % takes party %, the line names %',
      new.account_id, coalesce(v_party::text, 'none'), coalesce(new.party_type::text, 'none')
      using errcode = 'check_violation';
  end if;

  if v_branch is not null and new.branch_id is distinct from v_branch then
    raise exception 'JOURNAL_LINE_INVALID: account % belongs to branch %, the line names %',
      new.account_id, v_branch, coalesce(new.branch_id::text, 'none')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists journal_lines_before_insert on "ledger"."journal_lines";
--> statement-breakpoint
create trigger journal_lines_before_insert
  before insert on "ledger"."journal_lines"
  for each row execute function ledger.before_journal_line_insert();
--> statement-breakpoint

-- Accounts: what an account *is* never changes once it exists. Renaming and
-- deactivating are allowed; turning a wallet into an expense account under
-- the lines already posted to it is not.
create or replace function ledger.freeze_account_identity()
returns trigger
language plpgsql
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.code is distinct from old.code
     or new.class is distinct from old.class
     or new.subtype is distinct from old.subtype
     or new.normal_balance is distinct from old.normal_balance
     or new.branch_id is distinct from old.branch_id
     or new.party_type is distinct from old.party_type
     or new.is_system is distinct from old.is_system then
    raise exception 'LEDGER_ACCOUNT_INVALID: account % can be renamed or deactivated, nothing else',
      old.code
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists accounts_freeze_identity on "ledger"."accounts";
--> statement-breakpoint
create trigger accounts_freeze_identity
  before update on "ledger"."accounts"
  for each row execute function ledger.freeze_account_identity();
--> statement-breakpoint

-- 5. Periods.
create or replace function ledger.guard_period_change()
returns trigger
language plpgsql
as $$
declare
  v_type text;
  v_status text;
  v_payload jsonb;
  v_created timestamptz;
  v_decided timestamptz;
begin
  -- Exclusive: waits for every in-flight post of this month, blocks new ones
  -- until this transaction ends.
  perform pg_advisory_xact_lock(ledger.period_lock_key(new.org_id, new.starts_on));

  if tg_op = 'INSERT' then
    if new.status <> 'closed' or new.reopen_approval_id is not null or new.reopened_at is not null then
      raise exception 'PERIOD_INVALID: a period row is created by closing the month'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.starts_on is distinct from old.starts_on
     or new.ends_on is distinct from old.ends_on then
    raise exception 'PERIOD_INVALID: a period''s identity cannot change'
      using errcode = 'check_violation';
  end if;

  if old.status = 'open' and new.status = 'closed' then
    if new.reopen_approval_id is distinct from old.reopen_approval_id
       or new.reopened_at is distinct from old.reopened_at then
      raise exception 'PERIOD_INVALID: closing a period does not rewrite its last reopening'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if old.status = 'closed' and new.status = 'open' then
    if new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by then
      raise exception 'PERIOD_INVALID: reopening keeps the record of who closed the period'
        using errcode = 'check_violation';
    end if;
    if new.reopened_at is null
       or new.reopen_approval_id is null
       or new.reopen_approval_id is not distinct from old.reopen_approval_id then
      raise exception 'PERIOD_REOPEN_UNAUTHORISED: reopening % needs a new approved period_reopen request',
        to_char(old.starts_on, 'YYYY-MM')
        using errcode = 'insufficient_privilege';
    end if;

    select type::text, status::text, payload, created_at, decided_at
      into v_type, v_status, v_payload, v_created, v_decided
      from approvals.approval_requests
     where id = new.reopen_approval_id and org_id = new.org_id;

    -- Approved, of the right type, about this period, and raised and decided
    -- after the close it undoes — so the approval that reopened this month
    -- last time cannot reopen it again after the next close.
    if old.closed_at is null
       or v_type is distinct from 'period_reopen'
       or v_status is distinct from 'approved'
       or (v_payload ->> 'periodId') is distinct from old.id::text
       or v_created < old.closed_at
       or v_decided < old.closed_at then
      raise exception 'PERIOD_REOPEN_UNAUTHORISED: approval % does not authorise reopening %',
        new.reopen_approval_id, to_char(old.starts_on, 'YYYY-MM')
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  raise exception 'PERIOD_INVALID: a period moves only open -> closed or closed -> open (was %, now %)',
    old.status, new.status
    using errcode = 'check_violation';
end;
$$;
--> statement-breakpoint
drop trigger if exists periods_guard on "ledger"."periods";
--> statement-breakpoint
create trigger periods_guard
  before insert or update on "ledger"."periods"
  for each row execute function ledger.guard_period_change();
