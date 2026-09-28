-- A settlement cannot post without an approval, and cannot change once one is
-- raised (M12 acceptance check 4; architecture §9, §7; D-037, D-072).
--
-- §9's settlement import ends "→ approval → posting", and the whole of this file is
-- making that sentence true in the database rather than in a service. Three
-- separate things have to hold, and each has its own failure:
--
--  1. **The terms are frozen from the moment an approval exists.** Otherwise a
--     ৳1 lakh batch is raised, approved, and edited to ৳10 lakh before it posts —
--     and the audit trail shows a checker approving the figure they saw. This is
--     the same defence migration 0033 gives a stock adjustment
--     (`STOCK_ADJUSTMENT_FROZEN`), for the same reason.
--  2. **`posted` names an approved `settlement_posting` whose amount is this
--     batch's.** An approval of the right type for the wrong amount, or for another
--     batch, is how a single approval would come to authorise a month of postings.
--  3. **A consignment is settled once.** Its receivable reaches zero once
--     (check 5); a second settlement crediting it again would make the courier's
--     balance negative and the cash real.

-- Legal transitions, and the frozen terms.
create or replace function courier.assert_settlement_change() returns trigger
language plpgsql as $$
declare
  approval record;
begin
  if tg_op = 'UPDATE' then
    -- imported → pending_approval | rejected
    -- pending_approval → posted | rejected
    -- posted, rejected: terminal.
    if old.status <> new.status then
      if not (
        (old.status = 'imported' and new.status in ('pending_approval', 'rejected'))
        or (old.status = 'pending_approval' and new.status in ('posted', 'rejected'))
      ) then
        raise exception 'SETTLEMENT_TRANSITION_INVALID: a settlement cannot go from % to %.',
          old.status, new.status;
      end if;
    end if;

    /*
     * The terms, frozen once the batch has left `imported`.
     *
     * `imported` is the only state in which a re-parse is legitimate — nobody has
     * been asked to approve anything yet — and even then the totals may only change
     * together with the lines, which the service does in one transaction.
     */
    if old.status <> 'imported' then
      if new.courier_account_id <> old.courier_account_id
         or new.courier_id <> old.courier_id
         or new.wallet_id <> old.wallet_id
         or new.settlement_date <> old.settlement_date
         or new.file_gross_poisha <> old.file_gross_poisha
         or new.file_charges_poisha <> old.file_charges_poisha
         or new.file_net_poisha <> old.file_net_poisha
         or new.file_row_count <> old.file_row_count
         or new.matched_gross_poisha <> old.matched_gross_poisha
         or new.matched_charges_poisha <> old.matched_charges_poisha
         or new.matched_delivery_charges_poisha <> old.matched_delivery_charges_poisha
         or new.matched_return_charges_poisha <> old.matched_return_charges_poisha
         or new.matched_other_charges_poisha <> old.matched_other_charges_poisha
         or new.matched_net_poisha <> old.matched_net_poisha
         or new.matched_row_count <> old.matched_row_count
         or new.exception_count <> old.exception_count
         or new.file_object_id is distinct from old.file_object_id then
        raise exception 'SETTLEMENT_FROZEN: this settlement''s terms were fixed when its approval was raised.';
      end if;
    end if;

    -- The approval, once named, is the approval that was named. Re-pointing it at a
    -- different request is the same attack as editing the amount.
    if old.approval_request_id is not null
       and new.approval_request_id is distinct from old.approval_request_id then
      raise exception 'SETTLEMENT_FROZEN: this settlement already names an approval request.';
    end if;

    -- A posted journal is never replaced (invariant 2). Corrections are reversals.
    if old.charges_journal_id is not null
       and new.charges_journal_id is distinct from old.charges_journal_id then
      raise exception 'LEDGER_IMMUTABLE: a settlement''s charges journal cannot be replaced.';
    end if;
    if old.cash_journal_id is not null
       and new.cash_journal_id is distinct from old.cash_journal_id then
      raise exception 'LEDGER_IMMUTABLE: a settlement''s cash journal cannot be replaced.';
    end if;
  end if;

  -- A journal may only exist on a settlement that has reached `posted`. Without
  -- this, a service that posted first and set the status afterwards would leave a
  -- window in which the books had moved and the screen said "waiting for approval".
  if new.status <> 'posted'
     and (new.charges_journal_id is not null or new.cash_journal_id is not null) then
    raise exception 'SETTLEMENT_NOT_APPROVED: a settlement''s journals exist only once it is posted.';
  end if;

  if new.status = 'posted' then
    if new.approval_request_id is null then
      raise exception 'APPROVAL_REQUIRED: a settlement posts only against an approved request (§9).';
    end if;

    select type, status, amount_poisha into approval
    from approvals.approval_requests
    where org_id = new.org_id and id = new.approval_request_id;

    if not found then
      raise exception 'APPROVAL_REQUIRED: that approval request does not exist in this organization.';
    end if;
    if approval.type <> 'settlement_posting' then
      raise exception 'APPROVAL_REQUIRED: a settlement posts against a settlement_posting request, not a %.',
        approval.type;
    end if;
    -- `auto_approved` counts: below the org's threshold the request is decided the
    -- moment it exists (D-068), and the executor that posts runs in that same
    -- transaction. What must never count is `pending`.
    if approval.status not in ('approved', 'auto_approved') then
      raise exception 'APPROVAL_REQUIRED: that approval request is %, not approved.', approval.status;
    end if;
    /*
     * The amount a checker saw has to be the amount that posts (D-072, D-078).
     *
     * The matched **gross** is the figure, not the net: it is what the two journals
     * together take off the courier's balance, so it is the size of the whole
     * transaction. Approving the net would understate a statement that was mostly
     * charges.
     */
    if approval.amount_poisha is distinct from new.matched_gross_poisha then
      raise exception 'APPROVAL_REQUIRED: the approved amount is not this settlement''s matched total.';
    end if;
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_settlement_change
before insert or update on courier.settlements
for each row execute function courier.assert_settlement_change();--> statement-breakpoint

-- A consignment is settled once, by a settlement that has posted.
--
-- `settled_at` and `settlement_id` move from null to a value and never again: the
-- consignment's receivable reached zero, and crediting it a second time would make
-- the courier's balance negative while the cash was real. Checked as a constraint
-- trigger so the settlement's own row can already be `posted` when the consignments
-- are linked in the same transaction.
create or replace function courier.assert_consignment_settlement() returns trigger
language plpgsql as $$
declare
  batch record;
begin
  if new.settlement_id is null then
    return null;
  end if;

  select status into batch
  from courier.settlements
  where org_id = new.org_id and id = new.settlement_id;

  if not found then
    raise exception 'SETTLEMENT_NOT_FOUND: no such settlement in this organization.';
  end if;
  if batch.status <> 'posted' then
    raise exception 'SETTLEMENT_NOT_APPROVED: a consignment is only settled by a settlement that has posted.';
  end if;

  return null;
end;
$$;--> statement-breakpoint

create constraint trigger courier_assert_consignment_settlement
after insert or update of settlement_id on courier.consignments
deferrable initially deferred
for each row execute function courier.assert_consignment_settlement();--> statement-breakpoint

create or replace function courier.refuse_resettlement() returns trigger
language plpgsql as $$
begin
  if old.settlement_id is not null and new.settlement_id is distinct from old.settlement_id then
    raise exception 'SETTLEMENT_ALREADY_POSTED: this consignment has already been settled.';
  end if;
  if old.settled_at is not null and new.settled_at is distinct from old.settled_at then
    raise exception 'SETTLEMENT_ALREADY_POSTED: this consignment has already been settled.';
  end if;
  -- The figure the matcher compares a statement against. Once a delivery has set it,
  -- editing it would let a settlement be made to match by moving our own books.
  if old.collected_poisha is not null and new.collected_poisha is distinct from old.collected_poisha then
    raise exception 'CONSIGNMENT_IMMUTABLE: what the courier collected is recorded once.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger courier_refuse_resettlement
before update of settlement_id, settled_at, collected_poisha on courier.consignments
for each row execute function courier.refuse_resettlement();
