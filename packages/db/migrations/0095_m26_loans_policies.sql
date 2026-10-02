-- Tenant isolation and integrity for M26's company loans (invariants 2 and 4, §5, §7, §15).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `loans.lenders`: UPDATE to rename or annotate; never DELETE. Journals name a lender as
--   their party, and a removed lender would orphan the loan payable lines.
-- * `loans.loans`, `loans.instalments`: INSERT and SELECT only. A loan's terms and its
--   schedule are what was signed, and its receipt journal was posted from them.
-- * `loans.payments`: UPDATE for exactly one transition, pending_approval → posted or
--   rejected, which the trigger below confines it to; never DELETE.
-- * `loans.reminders`: INSERT and SELECT only. A reminder went out or it did not.
--
-- No analytics read on any of them (D-049). Each refusal starts with a code from
-- `packages/contracts/src/errors.ts`.

alter table "loans"."lenders" enable row level security;
--> statement-breakpoint
alter table "loans"."lenders" force row level security;
--> statement-breakpoint
drop policy if exists "lenders_org_isolation" on "loans"."lenders";
--> statement-breakpoint
create policy "lenders_org_isolation" on "loans"."lenders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "loans" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "loans"."lenders" to "erp_app";
--> statement-breakpoint
alter table "loans"."loans" enable row level security;
--> statement-breakpoint
alter table "loans"."loans" force row level security;
--> statement-breakpoint
drop policy if exists "loans_org_isolation" on "loans"."loans";
--> statement-breakpoint
create policy "loans_org_isolation" on "loans"."loans"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "loans" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "loans"."loans" to "erp_app";
--> statement-breakpoint
alter table "loans"."instalments" enable row level security;
--> statement-breakpoint
alter table "loans"."instalments" force row level security;
--> statement-breakpoint
drop policy if exists "instalments_org_isolation" on "loans"."instalments";
--> statement-breakpoint
create policy "instalments_org_isolation" on "loans"."instalments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "loans" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "loans"."instalments" to "erp_app";
--> statement-breakpoint
alter table "loans"."payments" enable row level security;
--> statement-breakpoint
alter table "loans"."payments" force row level security;
--> statement-breakpoint
drop policy if exists "payments_org_isolation" on "loans"."payments";
--> statement-breakpoint
create policy "payments_org_isolation" on "loans"."payments"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "loans" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "loans"."payments" to "erp_app";
--> statement-breakpoint
alter table "loans"."reminders" enable row level security;
--> statement-breakpoint
alter table "loans"."reminders" force row level security;
--> statement-breakpoint
drop policy if exists "reminders_org_isolation" on "loans"."reminders";
--> statement-breakpoint
create policy "reminders_org_isolation" on "loans"."reminders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "loans" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "loans"."reminders" to "erp_app";
--> statement-breakpoint

-- 1. Append-only, for every role. The missing grants are the control for `erp_app`; this
--    holds the owner to the same rule. A lender is renamed, never removed.
create or replace function loans.refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception 'LOAN_IMMUTABLE: % on loans.% is refused; these rows are a record.',
    tg_op, tg_table_name;
end;
$$;
--> statement-breakpoint
create trigger loans_refuse_change before update or delete on loans.loans
for each row execute function loans.refuse_change();
--> statement-breakpoint
create trigger instalments_refuse_change before update or delete on loans.instalments
for each row execute function loans.refuse_change();
--> statement-breakpoint
create trigger reminders_refuse_change before update or delete on loans.reminders
for each row execute function loans.refuse_change();
--> statement-breakpoint
create trigger lenders_refuse_delete before delete on loans.lenders
for each row execute function loans.refuse_change();
--> statement-breakpoint

-- 2. The schedule, checked at commit (M26 check 1 in the database). A loan has exactly
--    `tenure_months` instalments numbered 1..n, and their principal sums to the loan's.
--    Deferred, so the loan and its instalments are written in either order in one
--    transaction; on both tables, so an instalment added to a loan later is caught too.
create or replace function loans.assert_schedule() returns trigger
language plpgsql as $$
declare
  v_loan uuid;
  v_tenure integer;
  v_principal bigint;
  v_count integer;
  v_sum numeric;
  v_max integer;
begin
  if tg_table_name = 'loans' then
    v_loan := new.id;
  else
    v_loan := new.loan_id;
  end if;

  select tenure_months, principal_poisha into v_tenure, v_principal
    from loans.loans where id = v_loan;

  select count(*), coalesce(sum(principal_poisha), 0), coalesce(max(seq), 0)
    into v_count, v_sum, v_max
    from loans.instalments where loan_id = v_loan;

  if v_count <> v_tenure or v_max <> v_tenure then
    raise exception 'LOAN_SCHEDULE_INVALID: loan % has % instalment(s) for a tenure of %',
      v_loan, v_count, v_tenure
      using errcode = 'check_violation';
  end if;
  if v_sum <> v_principal then
    raise exception 'LOAN_SCHEDULE_INVALID: loan % schedules % poisha of principal for a loan of %',
      v_loan, v_sum, v_principal
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
--> statement-breakpoint
create constraint trigger loans_schedule_complete
  after insert on loans.loans
  deferrable initially deferred
  for each row execute function loans.assert_schedule();
--> statement-breakpoint
create constraint trigger instalments_schedule_complete
  after insert on loans.instalments
  deferrable initially deferred
  for each row execute function loans.assert_schedule();
--> statement-breakpoint

-- 3. A payment pays its instalment exactly, as scheduled (D-297), on the instalment's own
--    loan, and is born either waiting for a checker or posted.
create or replace function loans.assert_payment_born() returns trigger
language plpgsql as $$
declare
  v_loan uuid;
  v_principal bigint;
  v_interest bigint;
begin
  select loan_id, principal_poisha, interest_poisha into v_loan, v_principal, v_interest
    from loans.instalments where id = new.instalment_id and org_id = new.org_id;
  if v_loan is distinct from new.loan_id then
    raise exception 'LOAN_PAYMENT_INVALID: that instalment belongs to another loan.';
  end if;
  if new.principal_poisha <> v_principal or new.interest_poisha <> v_interest then
    raise exception 'LOAN_PAYMENT_INVALID: a payment pays its instalment as scheduled.';
  end if;
  if new.status not in ('pending_approval', 'posted') then
    raise exception 'LOAN_PAYMENT_INVALID: a payment is recorded waiting for approval or posted.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger payments_born
before insert on loans.payments
for each row execute function loans.assert_payment_born();
--> statement-breakpoint

-- 4. A payment's one transition: pending_approval → posted (with its journal) or rejected.
--    Its terms, its wallet and the approval it waited on never change.
create or replace function loans.assert_payment_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'LOAN_IMMUTABLE: a loan payment is never removed.';
  end if;
  if (new.id, new.org_id, new.loan_id, new.instalment_id, new.wallet_account_id,
      new.principal_poisha, new.interest_poisha, new.occurred_at, new.business_date,
      new.approval_request_id, new.memo, new.created_by, new.created_at)
     is distinct from
     (old.id, old.org_id, old.loan_id, old.instalment_id, old.wallet_account_id,
      old.principal_poisha, old.interest_poisha, old.occurred_at, old.business_date,
      old.approval_request_id, old.memo, old.created_by, old.created_at) then
    raise exception 'LOAN_IMMUTABLE: a payment''s terms are fixed once it is recorded.';
  end if;
  if old.status <> 'pending_approval' or new.status not in ('posted', 'rejected') then
    raise exception 'LOAN_IMMUTABLE: a payment cannot go from % to %.', old.status, new.status;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger payments_change
before update or delete on loans.payments
for each row execute function loans.assert_payment_change();
