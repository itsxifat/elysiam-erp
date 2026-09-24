-- Ledger hardening after the M03 ledger audit and security review.
--
-- 0014 made the ledger refuse corruption from a careless writer. Both reviews
-- then asked what a *determined* `erp_app` writer could still do, and the
-- answer was: reopen a closed month with an approval it forged, reuse an old
-- approval by leaving `closed_at` stale, and post into a month before a closed
-- one. Each is closed here, at the database, with a test beside it.
--
--   1. Approval rows are born pending (or auto-approved), their timestamps are
--      the database's, and a decision is recorded against the user the
--      transaction says is acting (W1, W2, security M3).
--   2. Only a platform super admin can be the decider a reopen rests on, and
--      only the owner role can make anyone one (W1, D-094).
--   3. Closing a month locks every earlier date too; the lock is per org, so a
--      close cannot interleave with a post into any month (W3, D-093).
--   4. Period timestamps are stamped here, not taken from the caller (W2).
--   5. Accounts: identity fully frozen, and a subtype fixes its class, normal
--      balance and party type (N1, N2).
--   6. A reversal must mirror the journal it reverses (N3).
--   7. Every function pins its search_path (security L5).

-- 1. Approval rows: born pending, stamped, decided by the acting user.
create or replace function approvals.stamp_request()
returns trigger
language plpgsql
set search_path = pg_catalog, approvals
as $$
declare
  v_actor text := nullif(current_setting('app.user_id', true), '');
begin
  if tg_op = 'INSERT' then
    if new.status::text not in ('pending', 'auto_approved') then
      raise exception 'APPROVAL_INVALID: a request is raised pending, not %', new.status
        using errcode = 'check_violation';
    end if;
    new.created_at := now();
    new.updated_at := now();
    if new.status::text = 'auto_approved' then
      new.decided_at := now();
    end if;
    return new;
  end if;

  new.created_at := old.created_at;
  if old.status::text = 'pending' and new.status::text <> 'pending' then
    new.decided_at := now();
    -- The decider is whoever the transaction says is acting. Checked only
    -- when an actor is set: owner-level repair scripts set none.
    if new.status::text in ('approved', 'rejected') and v_actor is not null
       and new.decided_by is distinct from v_actor then
      raise exception 'APPROVAL_INVALID: decided_by must be the acting user'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists zz_stamp_request on "approvals"."approval_requests";
--> statement-breakpoint
-- Named to fire after freeze_decided_request, which compares what the caller
-- sent; this then overwrites the timestamps with the database's own.
create trigger zz_stamp_request
  before insert or update on "approvals"."approval_requests"
  for each row execute function approvals.stamp_request();
--> statement-breakpoint

-- 2. Nobody but the owner makes a super admin. A trigger rather than column
-- grants: Drizzle (and Better Auth through it) names every column in an
-- INSERT, so a column-level grant without `is_super_admin` would break every
-- sign-up path, while this refuses only the one value that matters.
create or replace function iam.guard_super_admin()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
begin
  if current_user <> 'erp_owner'
     and new.is_super_admin
     and (tg_op = 'INSERT' or not old.is_super_admin) then
    raise exception 'IAM_FORBIDDEN: only the owner role grants super admin'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists users_guard_super_admin on "iam"."users";
--> statement-breakpoint
create trigger users_guard_super_admin
  before insert or update on "iam"."users"
  for each row execute function iam.guard_super_admin();
--> statement-breakpoint
-- Read through the owner, so the answer does not depend on what the caller
-- may see. Returns only a boolean.
create or replace function ledger.is_platform_super_admin(p_user text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, iam
as $$
  select coalesce(
    (select u.is_super_admin and u.is_active from iam.users u where u.id = p_user),
    false)
$$;
--> statement-breakpoint
revoke all on function ledger.is_platform_super_admin(text) from public;
--> statement-breakpoint
grant execute on function ledger.is_platform_super_admin(text) to "erp_app";
--> statement-breakpoint

-- 3. One lock per org for the period rules.
create or replace function ledger.org_period_lock_key(p_org uuid)
returns bigint
language sql
immutable
set search_path = pg_catalog
as $$
  select hashtextextended('ledger.periods:' || p_org::text, 0)
$$;
--> statement-breakpoint
create or replace function ledger.before_journal_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, ledger
as $$
declare
  v_month date := date_trunc('month', new.business_date)::date;
  v_closed date;
begin
  new.created_txid := pg_current_xact_id();

  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'LEDGER_ISOLATION: journals must be posted under READ COMMITTED, not %',
      current_setting('transaction_isolation')
      using errcode = 'feature_not_supported';
  end if;

  perform pg_advisory_xact_lock_shared(ledger.org_period_lock_key(new.org_id));

  -- Balances are cumulative: a journal dated in or before a closed month
  -- changes that month's closing figures. So the lock covers every date up to
  -- the latest closed month, not only the closed month itself (W3, D-093).
  select max(starts_on) into v_closed
    from ledger.periods
   where org_id = new.org_id and status = 'closed' and starts_on >= v_month;

  if v_closed is not null then
    raise exception 'PERIOD_CLOSED: % falls on or before %, which is closed', new.business_date,
      to_char(v_closed, 'YYYY-MM')
      using errcode = 'check_violation',
            hint = 'Reopening needs an approved period_reopen for every closed month from this one on.';
  end if;

  return new;
end;
$$;
--> statement-breakpoint

-- 4. Periods: the database's clock and actor, a super admin's approval.
create or replace function ledger.guard_period_change()
returns trigger
language plpgsql
set search_path = pg_catalog, ledger, approvals
as $$
declare
  v_actor text := nullif(current_setting('app.user_id', true), '');
  v_type text;
  v_status text;
  v_payload jsonb;
  v_created timestamptz;
  v_decided timestamptz;
  v_decider text;
begin
  perform pg_advisory_xact_lock(ledger.org_period_lock_key(new.org_id));

  if tg_op = 'INSERT' then
    if new.status <> 'closed' or new.reopen_approval_id is not null or new.reopened_at is not null then
      raise exception 'PERIOD_INVALID: a period row is created by closing the month'
        using errcode = 'check_violation';
    end if;
    new.closed_at := now();
    new.closed_by := coalesce(v_actor, new.closed_by);
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.starts_on is distinct from old.starts_on
     or new.ends_on is distinct from old.ends_on
     or new.created_at is distinct from old.created_at then
    raise exception 'PERIOD_INVALID: a period''s identity cannot change'
      using errcode = 'check_violation';
  end if;

  if old.status = 'open' and new.status = 'closed' then
    if new.reopen_approval_id is distinct from old.reopen_approval_id
       or new.reopened_at is distinct from old.reopened_at then
      raise exception 'PERIOD_INVALID: closing a period does not rewrite its last reopening'
        using errcode = 'check_violation';
    end if;
    -- Stamped, so a re-close always moves closed_at forward and every
    -- approval raised before it is spent (W2).
    new.closed_at := now();
    new.closed_by := coalesce(v_actor, new.closed_by);
    return new;
  end if;

  if old.status = 'closed' and new.status = 'open' then
    if new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by then
      raise exception 'PERIOD_INVALID: reopening keeps the record of who closed the period'
        using errcode = 'check_violation';
    end if;
    if new.reopen_approval_id is null
       or new.reopen_approval_id is not distinct from old.reopen_approval_id then
      raise exception 'PERIOD_REOPEN_UNAUTHORISED: reopening % needs a new approved period_reopen request',
        to_char(old.starts_on, 'YYYY-MM')
        using errcode = 'insufficient_privilege';
    end if;
    new.reopened_at := now();

    select type::text, status::text, payload, created_at, decided_at, decided_by
      into v_type, v_status, v_payload, v_created, v_decided, v_decider
      from approvals.approval_requests
     where id = new.reopen_approval_id and org_id = new.org_id;

    -- Approved, of the right type, about this period, raised and decided
    -- after the close it undoes, decided by a platform super admin (§7), and
    -- that super admin is who is acting now: the reopen happens in the
    -- transaction that approves it (D-081).
    if old.closed_at is null
       or v_type is distinct from 'period_reopen'
       or v_status is distinct from 'approved'
       or (v_payload ->> 'periodId') is distinct from old.id::text
       or v_created < old.closed_at
       or v_decided < old.closed_at
       or v_decider is null
       or v_decider is distinct from v_actor
       or not ledger.is_platform_super_admin(v_decider) then
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
drop function if exists ledger.period_lock_key(uuid, date);
--> statement-breakpoint

-- 5. Accounts.
--
-- What each subtype is, as the database knows it. Kept in step with
-- ACCOUNT_SUBTYPES in @elysium/domain by ledger-sync.test.ts.
create or replace function ledger.subtype_shape(p_subtype ledger.account_subtype)
returns table (class ledger.account_class, normal_balance ledger.normal_balance, party_type ledger.party_type)
language sql
immutable
set search_path = pg_catalog, ledger
as $$
  select s.class::ledger.account_class, s.normal_balance::ledger.normal_balance,
         s.party_type::ledger.party_type
  from (values
    ('wallet_cash', 'asset', 'debit', null),
    ('wallet_bank', 'asset', 'debit', null),
    ('wallet_bkash', 'asset', 'debit', null),
    ('wallet_mfs_other', 'asset', 'debit', null),
    ('courier_receivable', 'asset', 'debit', 'courier'),
    ('inventory', 'asset', 'debit', null),
    ('goods_in_transit', 'asset', 'debit', null),
    ('supplier_advance', 'asset', 'debit', 'supplier'),
    ('employee_loan_receivable', 'asset', 'debit', 'employee'),
    ('other_receivable', 'asset', 'debit', null),
    ('supplier_payable', 'liability', 'credit', 'supplier'),
    ('reseller_payable', 'liability', 'credit', 'reseller'),
    ('salary_payable', 'liability', 'credit', null),
    ('investor_payable', 'liability', 'credit', 'investor'),
    ('loan_payable', 'liability', 'credit', 'lender'),
    ('customer_advance', 'liability', 'credit', null),
    ('other_payable', 'liability', 'credit', null),
    ('owner_capital', 'equity', 'credit', null),
    ('investor_capital', 'equity', 'credit', 'investor'),
    ('retained_earnings', 'equity', 'credit', null),
    ('profit_distribution', 'equity', 'debit', null),
    ('sales_revenue', 'income', 'credit', null),
    ('sales_discounts', 'income', 'debit', null),
    ('delivery_charge_income', 'income', 'credit', null),
    ('other_income', 'income', 'credit', null),
    ('inventory_adjustment_gain', 'income', 'credit', null),
    ('cogs', 'expense', 'debit', null),
    ('courier_charges', 'expense', 'debit', null),
    ('return_charges', 'expense', 'debit', null),
    ('ad_spend', 'expense', 'debit', null),
    ('salary_expense', 'expense', 'debit', null),
    ('bonus_expense', 'expense', 'debit', null),
    ('interest_expense', 'expense', 'debit', null),
    ('inventory_writeoff', 'expense', 'debit', null),
    ('purchase_price_variance', 'expense', 'debit', null),
    ('cash_over_short', 'expense', 'debit', null),
    ('bank_charges', 'expense', 'debit', null),
    ('operating_expense', 'expense', 'debit', null)
  ) as s(subtype, class, normal_balance, party_type)
  where s.subtype = p_subtype::text
$$;
--> statement-breakpoint
create or replace function ledger.freeze_account_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, ledger
as $$
declare
  v_shape record;
begin
  if tg_op = 'INSERT' then
    select * into v_shape from ledger.subtype_shape(new.subtype);
    if not found
       or new.class is distinct from v_shape.class
       or new.normal_balance is distinct from v_shape.normal_balance
       or new.party_type is distinct from v_shape.party_type then
      raise exception 'LEDGER_ACCOUNT_INVALID: a % account is %, %-normal, party %',
        new.subtype, v_shape.class, v_shape.normal_balance, coalesce(v_shape.party_type::text, 'none')
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.code is distinct from old.code
     or new.class is distinct from old.class
     or new.subtype is distinct from old.subtype
     or new.normal_balance is distinct from old.normal_balance
     or new.branch_id is distinct from old.branch_id
     or new.party_type is distinct from old.party_type
     or new.is_system is distinct from old.is_system
     or new.created_at is distinct from old.created_at then
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
  before insert or update on "ledger"."accounts"
  for each row execute function ledger.freeze_account_identity();
--> statement-breakpoint

-- 6. Balance, and for a reversal, the mirror image of what it reverses.
create or replace function ledger.assert_journal_balanced()
returns trigger
language plpgsql
set search_path = pg_catalog, ledger
as $$
declare
  v_journal uuid;
  v_reverses uuid;
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

  select reverses_journal_id into v_reverses from ledger.journals where id = v_journal;
  if v_reverses is not null and exists (
    (select account_id, branch_id, party_type, party_id, credit_poisha, debit_poisha
       from ledger.journal_lines where journal_id = v_reverses
     except all
     select account_id, branch_id, party_type, party_id, debit_poisha, credit_poisha
       from ledger.journal_lines where journal_id = v_journal)
    union all
    (select account_id, branch_id, party_type, party_id, debit_poisha, credit_poisha
       from ledger.journal_lines where journal_id = v_journal
     except all
     select account_id, branch_id, party_type, party_id, credit_poisha, debit_poisha
       from ledger.journal_lines where journal_id = v_reverses)
  ) then
    raise exception 'JOURNAL_LINE_INVALID: journal % does not mirror journal %, which it reverses',
      v_journal, v_reverses
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;
--> statement-breakpoint

-- 7. Pinned search paths for the functions 0014 left unpinned.
alter function ledger.before_journal_line_insert() set search_path = pg_catalog, ledger;
--> statement-breakpoint
alter function ledger.refuse_change() set search_path = pg_catalog, ledger;
