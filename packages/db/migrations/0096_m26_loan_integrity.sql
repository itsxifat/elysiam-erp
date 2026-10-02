-- M26's ledger audit, in the database (W2, W3, N4; D-298, D-304).
--
-- 1. A loan recorded by mistake can be voided, once, against the journal that reverses its
--    receipt, and only while nothing is repaid or waiting. That is the only change any role
--    may make to a loan; erp_app gains UPDATE for it and nothing else.
-- 2. A repayment's state is tied to its approval and its journal, not only to the service:
--    born waiting, it names a pending `loan_repayment` request for exactly its amount and
--    itself; posted, its journal is its own instalment's; it moves to posted only on an
--    approved request and to rejected only on a rejected one; and no repayment is taken on
--    a voided loan.
--
-- Approval types are compared as text, so nothing here uses the `loan_repayment` enum value
-- as a literal in the transaction that may have added it (0094). Each refusal starts with a
-- code from `packages/contracts/src/errors.ts`.

grant update on "loans"."loans" to "erp_app";
--> statement-breakpoint
drop trigger if exists loans_refuse_change on loans.loans;
--> statement-breakpoint
create or replace function loans.assert_loan_change() returns trigger
language plpgsql as $$
declare
  v_reverses uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'LOAN_IMMUTABLE: a loan is never removed; void it instead.';
  end if;

  if (new.id, new.org_id, new.lender_id, new.reference, new.principal_poisha, new.rate_bps,
      new.method, new.tenure_months, new.received_on, new.first_due_on, new.reminder_days,
      new.reminder_phone, new.wallet_account_id, new.received_journal_id, new.memo,
      new.created_by, new.created_at)
     is distinct from
     (old.id, old.org_id, old.lender_id, old.reference, old.principal_poisha, old.rate_bps,
      old.method, old.tenure_months, old.received_on, old.first_due_on, old.reminder_days,
      old.reminder_phone, old.wallet_account_id, old.received_journal_id, old.memo,
      old.created_by, old.created_at) then
    raise exception 'LOAN_IMMUTABLE: a loan''s terms are what was signed; void it and record it again.';
  end if;

  if old.voided_at is not null or new.voided_at is null then
    raise exception 'LOAN_IMMUTABLE: a loan is voided once, and only that.';
  end if;

  if exists (select 1 from loans.payments p
             where p.org_id = new.org_id and p.loan_id = new.id and p.status <> 'rejected') then
    raise exception 'LOAN_IMMUTABLE: a loan with a repayment posted or waiting cannot be voided.';
  end if;

  select reverses_journal_id into v_reverses
    from ledger.journals where org_id = new.org_id and id = new.void_journal_id;
  if v_reverses is distinct from new.received_journal_id then
    raise exception 'LOAN_IMMUTABLE: a void names the journal that reverses the loan''s receipt.';
  end if;

  return new;
end;
$$;
--> statement-breakpoint
create trigger loans_change
before update or delete on loans.loans
for each row execute function loans.assert_loan_change();
--> statement-breakpoint

create or replace function loans.assert_payment_born() returns trigger
language plpgsql as $$
declare
  v_loan uuid;
  v_principal bigint;
  v_interest bigint;
  v_voided timestamptz;
  v_journal record;
  v_approval record;
begin
  select i.loan_id, i.principal_poisha, i.interest_poisha, l.voided_at
    into v_loan, v_principal, v_interest, v_voided
    from loans.instalments i
    join loans.loans l on l.org_id = i.org_id and l.id = i.loan_id
   where i.id = new.instalment_id and i.org_id = new.org_id;
  if v_loan is distinct from new.loan_id then
    raise exception 'LOAN_PAYMENT_INVALID: that instalment belongs to another loan.';
  end if;
  if v_voided is not null then
    raise exception 'LOAN_PAYMENT_INVALID: that loan is void.';
  end if;
  if new.principal_poisha <> v_principal or new.interest_poisha <> v_interest then
    raise exception 'LOAN_PAYMENT_INVALID: a payment pays its instalment as scheduled.';
  end if;

  if new.status = 'posted' then
    -- Under the threshold: posted at once, with no request, on the instalment's own journal.
    if new.approval_request_id is not null then
      raise exception 'LOAN_PAYMENT_INVALID: a repayment that waited for a checker is born waiting.';
    end if;
    select source_type, source_id into v_journal
      from ledger.journals where org_id = new.org_id and id = new.journal_id;
    if v_journal.source_type is distinct from 'loan_instalment'
       or v_journal.source_id is distinct from new.instalment_id then
      raise exception 'LOAN_PAYMENT_INVALID: a repayment posts its own instalment''s journal.';
    end if;
  elsif new.status = 'pending_approval' then
    select type::text as type, status::text as status, amount_poisha, payload into v_approval
      from approvals.approval_requests
     where org_id = new.org_id and id = new.approval_request_id;
    if not found or v_approval.type <> 'loan_repayment' or v_approval.status <> 'pending'
       or v_approval.amount_poisha is distinct from new.principal_poisha + new.interest_poisha
       or v_approval.payload ->> 'paymentId' is distinct from new.id::text then
      raise exception 'LOAN_PAYMENT_INVALID: a waiting repayment names a pending loan_repayment request for itself and its amount.';
    end if;
  else
    raise exception 'LOAN_PAYMENT_INVALID: a payment is recorded waiting for approval or posted.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint

create or replace function loans.assert_payment_change() returns trigger
language plpgsql as $$
declare
  v_journal record;
  v_approval record;
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

  select type::text as type, status::text as status, amount_poisha, payload into v_approval
    from approvals.approval_requests
   where org_id = new.org_id and id = new.approval_request_id;
  if not found or v_approval.type <> 'loan_repayment'
     or v_approval.payload ->> 'paymentId' is distinct from new.id::text then
    raise exception 'LOAN_PAYMENT_INVALID: that approval is not this repayment''s.';
  end if;

  if new.status = 'posted' then
    if v_approval.status not in ('approved', 'auto_approved')
       or v_approval.amount_poisha is distinct from new.principal_poisha + new.interest_poisha then
      raise exception 'LOAN_PAYMENT_INVALID: a repayment posts only on its approved request, for its amount.';
    end if;
    select source_type, source_id into v_journal
      from ledger.journals where org_id = new.org_id and id = new.journal_id;
    if v_journal.source_type is distinct from 'loan_instalment'
       or v_journal.source_id is distinct from new.instalment_id then
      raise exception 'LOAN_PAYMENT_INVALID: a repayment posts its own instalment''s journal.';
    end if;
  elsif v_approval.status <> 'rejected' then
    raise exception 'LOAN_PAYMENT_INVALID: a repayment is rejected only with its request.';
  end if;
  return new;
end;
$$;
