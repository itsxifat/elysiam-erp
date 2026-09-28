-- Three holes an audit of M12 found in 0051, closed at the row (M12; §7, §9; D-037, D-078).
--
-- All three are cases where the *service* is now correct and the *database* was not, which is
-- the wrong way round for money: a service can be refactored, called from a worker, or bypassed
-- by the next module that needs "just one row". Each is a separate failure with a separate
-- symptom, and none of them is loud.
--
--  1. **An approval was not bound to its settlement.** 0051 checks the approval's org, type,
--     status and amount — but never that it is the approval *this batch* named. Two batches of
--     the same courier with the same matched gross are routine for a fixed-COD product line,
--     and they were interchangeable.
--  2. **D-037's posting date was not frozen after posting.** The frozen-column list in 0051
--     stops at `pending_approval`'s terms and omits `posting_business_date`,
--     `deferred_from_closed_period` and `posted_at`, so a posted row's resolved date could be
--     rewritten afterwards and made to disagree with the immutable journals it names. No money
--     moves, but the D-037 evidence field is the thing 0051 exists to protect.
--  3. **A collection could be recorded with no journal behind it.** `collected_poisha` is what
--     `settlementCandidates` reports as the courier's debt, and its matching debit comes from
--     §7's delivery journal. A `delivered` event reaching an order that is not `shipped` — a
--     late webhook after a return, a parcel whose order never shipped — used to write the
--     figure anyway, which made the consignment a matchable settlement candidate whose credit
--     had no debit. The two settlement journals then drove the courier's balance **negative**,
--     and the only symptom was a variance in the reconciliation report.

-- 1 and 2: replace 0051's settlement guard with one that also binds the approval to the batch
-- and freezes the posting evidence.
--
-- `create or replace` on the same function name rather than a second trigger: 0051's trigger
-- already points at `courier.assert_settlement_change`, and two triggers with overlapping rules
-- would raise different messages for the same row depending on firing order.
create or replace function courier.assert_settlement_change() returns trigger
language plpgsql as $$
declare
  approval record;
begin
  if tg_op = 'UPDATE' then
    if old.status <> new.status then
      if not (
        (old.status = 'imported' and new.status in ('pending_approval', 'rejected'))
        or (old.status = 'pending_approval' and new.status in ('posted', 'rejected'))
      ) then
        raise exception 'SETTLEMENT_TRANSITION_INVALID: a settlement cannot go from % to %.',
          old.status, new.status;
      end if;
    end if;

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

    /*
     * Hole 2. A posted settlement's evidence is as immutable as its journals.
     *
     * `posting_business_date` is D-037's answer to "which period did this land in", and
     * `settlement_date` is its "which period was it for". The pair is the whole decision, and
     * the journals that carry the first are already immutable (invariant 2) — so letting the
     * row's copy drift would make the row and the ledger disagree about a settlement nobody can
     * re-post. `posted_at` goes with them.
     */
    if old.status = 'posted' then
      if new.posting_business_date is distinct from old.posting_business_date
         or new.deferred_from_closed_period is distinct from old.deferred_from_closed_period
         or new.posted_at is distinct from old.posted_at then
        raise exception 'SETTLEMENT_FROZEN: a posted settlement''s dates are fixed; correct it with a reversal.';
      end if;
    end if;

    if old.approval_request_id is not null
       and new.approval_request_id is distinct from old.approval_request_id then
      raise exception 'SETTLEMENT_FROZEN: this settlement already names an approval request.';
    end if;

    if old.charges_journal_id is not null
       and new.charges_journal_id is distinct from old.charges_journal_id then
      raise exception 'LEDGER_IMMUTABLE: a settlement''s charges journal cannot be replaced.';
    end if;
    if old.cash_journal_id is not null
       and new.cash_journal_id is distinct from old.cash_journal_id then
      raise exception 'LEDGER_IMMUTABLE: a settlement''s cash journal cannot be replaced.';
    end if;
  end if;

  if new.status <> 'posted'
     and (new.charges_journal_id is not null or new.cash_journal_id is not null) then
    raise exception 'SETTLEMENT_NOT_APPROVED: a settlement''s journals exist only once it is posted.';
  end if;

  if new.status = 'posted' then
    if new.approval_request_id is null then
      raise exception 'APPROVAL_REQUIRED: a settlement posts only against an approved request (§9).';
    end if;

    select type, status, amount_poisha, payload into approval
    from approvals.approval_requests
    where org_id = new.org_id and id = new.approval_request_id;

    if not found then
      raise exception 'APPROVAL_REQUIRED: that approval request does not exist in this organization.';
    end if;
    if approval.type <> 'settlement_posting' then
      raise exception 'APPROVAL_REQUIRED: a settlement posts against a settlement_posting request, not a %.',
        approval.type;
    end if;
    if approval.status not in ('approved', 'auto_approved') then
      raise exception 'APPROVAL_REQUIRED: that approval request is %, not approved.', approval.status;
    end if;
    if approval.amount_poisha is distinct from new.matched_gross_poisha then
      raise exception 'APPROVAL_REQUIRED: the approved amount is not this settlement''s matched total.';
    end if;
    /*
     * Hole 1. The approval has to be about *this* batch.
     *
     * 0051's comment claimed this — "an approval of the right type for the wrong amount, or for
     * another batch" — and only the amount half was implemented. The payload's `settlementId` is
     * frozen when the request is raised (migration 0011), so it is a safe thing to compare
     * against, and it is the only field that distinguishes two batches of the same courier with
     * the same total.
     */
    if approval.payload ->> 'settlementId' is distinct from new.id::text then
      raise exception 'APPROVAL_REQUIRED: that approval belongs to a different settlement.';
    end if;
  end if;

  return new;
end;
$$;--> statement-breakpoint

-- 3: a collection is only recordable on a parcel whose order actually shipped.
--
-- `sales.orders.handed_over_at` is set by §9's `ship` transition, which is the same transition
-- that posts the goods-in-transit journal — so its presence is the database's evidence that the
-- units left and that a delivery journal is possible at all. Checked on the column rather than
-- on the status, because an order that shipped and has since been `returned` must still be able
-- to carry the collection its delivery recorded.
--
-- Deliberately *not* a check that the journal exists: the consignment row and the journal are
-- written in the same transaction and the order of the two statements is the service's business.
-- This refuses the case the service can get wrong, which is recording a collection for a parcel
-- that was never dispatched.
create or replace function courier.assert_collection_has_dispatch() returns trigger
language plpgsql as $$
declare
  shipped_at timestamptz;
begin
  if new.collected_poisha is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.collected_poisha is not null then
    -- Already recorded, and 0051's `refuse_resettlement` owns whether it may change.
    return new;
  end if;

  select handed_over_at into shipped_at
  from sales.orders
  where org_id = new.org_id and id = new.order_id;

  if not found then
    raise exception 'ORDER_NOT_FOUND: no such order in this organization.';
  end if;
  if shipped_at is null then
    raise exception 'CONSIGNMENT_INVALID: a collection cannot be recorded for a parcel whose order never shipped.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger courier_assert_collection_has_dispatch
before insert or update of collected_poisha on courier.consignments
for each row execute function courier.assert_collection_has_dispatch();
