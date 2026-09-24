-- Close two gaps 0009 left open (architecture §6, §25).
--
-- 0009 froze a decided approval against UPDATE. Two ways round it survived, and
-- an adversarial pass found both:
--
-- 1. **Approve and alter in one statement.** The trigger compared the new row
--    against the old row's status, so an UPDATE that moved `pending -> approved`
--    *and* changed `amount_poisha` in the same statement passed: at that moment
--    `old.status` is still 'pending', which is the branch that allows anything.
--    The terms a checker approves must be the terms that were requested.
--
-- 2. **INSERT an already-decided row.** The trigger is BEFORE UPDATE only, so a
--    job or a repair script could insert a row that was born approved. The
--    maker≠checker CHECK still applies, but nothing required that the decision
--    ever passed through `decide()`.
--
-- `reason` and `decision_note` are deliberately still writable on a decided row:
-- a checker adding context after the fact changes no term of what was
-- authorised, and forbidding it would push people to raise duplicate requests.

create or replace function approvals.freeze_decided_request()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'pending' then
    -- Still open. The one thing that may change here is the decision itself,
    -- and the terms must not move while it is being taken.
    if new.status <> 'pending'
       and (new.type is distinct from old.type
            or new.amount_poisha is distinct from old.amount_poisha
            or new.payload is distinct from old.payload
            or new.requested_by is distinct from old.requested_by
            or new.org_id is distinct from old.org_id) then
      raise exception
        'approval % cannot be decided and altered in one statement', old.id
        using errcode = 'integrity_constraint_violation',
              hint = 'A checker approves the terms that were requested.';
    end if;
    return new;
  end if;

  -- Decided or cancelled. The terms are fixed.
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

  -- And a decision cannot be undone or re-taken.
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
create or replace function approvals.request_is_born_pending()
returns trigger
language plpgsql
as $$
begin
  if new.status <> 'pending' then
    raise exception
      'an approval request is created pending, not %', new.status
      using errcode = 'integrity_constraint_violation',
            hint = 'Insert the request, then decide it.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists request_is_born_pending on "approvals"."approval_requests";
--> statement-breakpoint
create trigger request_is_born_pending
  before insert on "approvals"."approval_requests"
  for each row
  execute function approvals.request_is_born_pending();
