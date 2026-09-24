-- A decision is final (architecture §6, §25).
--
-- The two CHECK constraints in 0007 hold the *shape* of a decision: maker is
-- not checker, and a decided row carries both a decider and a time. Neither
-- stops a decided row being edited afterwards, and `erp_app` held UPDATE and
-- DELETE on the table.
--
-- Reproduced against a live database before writing this:
--
--   insert  … status='approved', requested_by='maker1', decided_by='checker1',
--            amount_poisha=50000
--   update  … set amount_poisha = 500000000            -> UPDATE 1
--   update  … set status='pending', decided_by=null    -> UPDATE 1
--   update  … set status='approved', decided_by='checker2'  -> re-approved
--
-- That is the attack the whole module exists to prevent: get 500 taka approved,
-- edit the row, and the executor in M03+ reads `amount_poisha` and `payload`
-- *after* approval. The audit log would show an honest approval of 500 taka.
--
-- The service is not the place to fix it. The argument written into
-- `approvals.service.ts` is that a service can be refactored, called from a job
-- or bypassed by the next module, which is why maker≠checker is a constraint —
-- and that argument applies unchanged here.
--
-- A trigger rather than a CHECK because the rule is about the *transition*
-- (old row versus new row), which a CHECK cannot see.

create or replace function approvals.freeze_decided_request()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'pending' then
    -- Still open: anything may change, including being decided.
    return new;
  end if;

  -- Decided or cancelled. The terms of what was authorised are now fixed.
  if new.type is distinct from old.type
     or new.amount_poisha is distinct from old.amount_poisha
     or new.payload is distinct from old.payload
     or new.requested_by is distinct from old.requested_by
     or new.org_id is distinct from old.org_id then
    raise exception
      'approval % is % and its terms cannot change', old.id, old.status
      using errcode = 'integrity_constraint_violation',
            hint = 'Raise a new request rather than editing a decided one.';
  end if;

  -- And a decision cannot be undone or re-taken. Without this, approved ->
  -- pending -> approved lets a second checker launder a decision.
  if new.status is distinct from old.status
     or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at then
    raise exception
      'approval % is already %', old.id, old.status
      using errcode = 'integrity_constraint_violation',
            hint = 'A decision is final. Raise a new request.';
  end if;

  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists freeze_decided_request on "approvals"."approval_requests";
--> statement-breakpoint
create trigger freeze_decided_request
  before update on "approvals"."approval_requests"
  for each row
  execute function approvals.freeze_decided_request();
--> statement-breakpoint
-- A maker-checker record is evidence in the same sense the audit log is: it is
-- what says a payment was authorised. A bug or a compromised handler that can
-- erase it leaves the payment with no trail, so the application does not get
-- to delete one. Cancelling is a status, not a deletion.
revoke delete on "approvals"."approval_requests" from "erp_app";
