ALTER TABLE "approvals"."approval_requests" ADD COLUMN "amount_derived_by_server" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "iam"."memberships" ADD COLUMN "granted_by" text;--> statement-breakpoint
-- NOT VALID for the same reason as 0011: rows written before this rule are
-- frozen evidence, reviewed and then validated by an operator (D-076).
ALTER TABLE "approvals"."approval_requests" ADD CONSTRAINT "approval_requests_branch_items_never_auto_approved" CHECK ("approvals"."approval_requests"."status"::text <> 'auto_approved' or "approvals"."approval_requests"."type"::text not in ('stock_write_off', 'stock_gain', 'closing_variance')) NOT VALID;--> statement-breakpoint
-- The terms of a request now include where its amount came from and why it
-- was raised, and a decided request's note is part of the decision (final
-- ledger pass, note 1). Everything 0011 froze stays frozen.
create or replace function approvals.freeze_decided_request()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at
     or new.type is distinct from old.type
     or new.amount_poisha is distinct from old.amount_poisha
     or new.amount_derived_by_server is distinct from old.amount_derived_by_server
     or new.threshold_poisha is distinct from old.threshold_poisha
     or new.payload is distinct from old.payload
     or new.reason is distinct from old.reason
     or new.requested_by is distinct from old.requested_by
     or new.branch_id is distinct from old.branch_id
     or new.org_id is distinct from old.org_id then
    raise exception
      'approval % is % and its terms cannot change', old.id, old.status
      using errcode = 'integrity_constraint_violation',
            hint = 'Raise a new request rather than editing one.';
  end if;

  if new.status::text = 'auto_approved' and old.status::text <> 'auto_approved' then
    raise exception
      'approval % cannot become auto_approved after it was raised', old.id
      using errcode = 'integrity_constraint_violation',
            hint = 'Only a request under the threshold at the moment it is raised is auto-approved.';
  end if;

  if old.status::text <> 'pending' and (
       new.status is distinct from old.status
       or new.decided_by is distinct from old.decided_by
       or new.decided_at is distinct from old.decided_at
       or new.decision_note is distinct from old.decision_note) then
    raise exception
      'approval % is already %', old.id, old.status
      using errcode = 'integrity_constraint_violation',
            hint = 'A decision is final. Raise a new request.';
  end if;

  return new;
end;
$$;
