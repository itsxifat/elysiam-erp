-- M26's second ledger audit, in the database (W-A, W-B, N2; D-304).
--
-- A new migration rather than an edit of 0096: 0094 and 0096 exist only on this branch, but
-- they were committed and applied by every test database since, and a migration that is
-- never edited is a rule worth not bending for convenience (invariant 9).
--
-- 1. A void and a repayment on one loan cannot both commit (W-A). A payment's insert reads
--    its loan `for share`, which waits for a void's row lock and then sees the void; a void's
--    row lock waits for that share lock and its trigger then sees the payment. (A foreign
--    key's `for key share` does not conflict with an UPDATE's `for no key update`, so the
--    reference alone never serialised the two.) Moving a waiting payment to posted checks
--    the loan the same way.
-- 2. The person who recorded a loan cannot void it (W-B): a void is a Cr of the whole
--    principal out of a wallet, and needs a second person, as M17's advances do (D-236).
-- 3. A request's `paymentId` is compared as a uuid, so its case cannot fail a real repayment
--    (N2).
--
-- Each refusal starts with a code from `packages/contracts/src/errors.ts`.

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

  if new.voided_by = old.created_by then
    raise exception 'LOAN_SELF_VOID: the person who recorded a loan cannot also void it.';
  end if;

  -- Under READ COMMITTED this query takes a fresh snapshot after the row lock above was
  -- granted, so a payment whose insert held the loan `for share` is seen once it commits.
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
  select loan_id, principal_poisha, interest_poisha into v_loan, v_principal, v_interest
    from loans.instalments
   where id = new.instalment_id and org_id = new.org_id;
  if v_loan is distinct from new.loan_id then
    raise exception 'LOAN_PAYMENT_INVALID: that instalment belongs to another loan.';
  end if;

  -- Held until this transaction ends: a void of this loan waits for it, and this waits for
  -- a void already under way and then reads what it wrote (W-A).
  select voided_at into v_voided
    from loans.loans where org_id = new.org_id and id = new.loan_id
    for share;
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
    select type::text as type, status::text as status, amount_poisha,
           lower(payload ->> 'paymentId') as payment_id
      into v_approval
      from approvals.approval_requests
     where org_id = new.org_id and id = new.approval_request_id;
    if not found or v_approval.type <> 'loan_repayment' or v_approval.status <> 'pending'
       or v_approval.amount_poisha is distinct from new.principal_poisha + new.interest_poisha
       or v_approval.payment_id is distinct from new.id::text then
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
  v_voided timestamptz;
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

  select type::text as type, status::text as status, amount_poisha,
         lower(payload ->> 'paymentId') as payment_id
    into v_approval
    from approvals.approval_requests
   where org_id = new.org_id and id = new.approval_request_id;
  if not found or v_approval.type <> 'loan_repayment'
     or v_approval.payment_id is distinct from new.id::text then
    raise exception 'LOAN_PAYMENT_INVALID: that approval is not this repayment''s.';
  end if;

  if new.status = 'posted' then
    select voided_at into v_voided
      from loans.loans where org_id = new.org_id and id = new.loan_id
      for share;
    if v_voided is not null then
      raise exception 'LOAN_PAYMENT_INVALID: that loan is void.';
    end if;
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
