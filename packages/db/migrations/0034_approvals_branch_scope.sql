-- §6's branch scope on approvals, made real for the approval that matters most
-- (M07; D-073, D-076, D-047).
--
-- ## What was already there, and what was not
--
-- `approvals.approval_requests.branch_id` arrived in migration 0010 with its
-- composite foreign key, its index, and the freeze that stops a decided request
-- being re-pointed at another branch; `ApprovalsService.requesterBranch` refuses a
-- request raised for a branch outside the requester's scope, and `decide` refuses a
-- checker outside it. So the column and the scope are enforced, and M07 inherited
-- that rather than having to build it.
--
-- What no layer could check was whether the branch on the request is the branch the
-- stock is actually in. `branch_id` is supplied by the requesting module, and the
-- approvals module has no way to look at a stock write-off and know which shelf it
-- empties. That gap is the whole of a branch manager's authority: §6 gives them
-- `stock_write_off` and `stock_gain` for **their** branch, and a request that
-- names their branch while emptying another one converts that grant into an
-- org-wide one.
--
-- So the link is checked from the inventory side, where both rows are visible: an
-- adjustment must name an approval of the matching type, in the same org, for the
-- same branch, at the same amount. The trigger lives on `inventory.adjustments`
-- rather than on the request because the request is written first — the service
-- raises the approval, then records what it is for.
--
-- The amount is compared too, and that is not redundant with D-078's "the executor
-- reads the approval's amount". D-078 governs what gets posted; this governs what
-- was judged. A request raised for two thousand taka against an adjustment worth
-- twenty would be approved by a branch manager under their threshold and then
-- refuse to post — a pending row nobody can clear. Refusing it at the insert names
-- the mistake where it was made.

create or replace function inventory.assert_adjustment_approval() returns trigger
language plpgsql as $$
declare
  req record;
  expected_type text;
begin
  if new.approval_request_id is null then
    -- The status CHECK already refuses `pending_approval` or `posted` without an
    -- approval; a rejected adjustment that never got one has nothing to compare.
    return new;
  end if;

  expected_type := case new.direction when 'loss' then 'stock_write_off' else 'stock_gain' end;

  select type::text as type, branch_id, amount_poisha, org_id
    into req
  from approvals.approval_requests
  where org_id = new.org_id and id = new.approval_request_id;

  if not found then
    raise exception 'STOCK_ADJUSTMENT_APPROVAL_INVALID: that approval request does not exist in this organization.';
  end if;
  if req.type <> expected_type then
    raise exception 'STOCK_ADJUSTMENT_APPROVAL_INVALID: a stock % needs a % request, not a %.',
      new.direction, expected_type, req.type;
  end if;
  -- `coalesce` on both sides: an org-level warehouse's adjustment carries no
  -- branch, and null <> null is null, which would pass this test silently.
  if coalesce(req.branch_id::text, '') <> coalesce(new.branch_id::text, '') then
    raise exception 'STOCK_ADJUSTMENT_APPROVAL_INVALID: that approval is for a different branch than the stock it would adjust.';
  end if;
  if req.amount_poisha is distinct from new.value_poisha then
    raise exception 'STOCK_ADJUSTMENT_APPROVAL_INVALID: that approval is for a different amount than the stock it would adjust.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger adjustments_assert_approval
before insert or update of approval_request_id, direction, branch_id, value_poisha
on inventory.adjustments
for each row execute function inventory.assert_adjustment_approval();
