ALTER TYPE "approvals"."approval_status" ADD VALUE 'auto_approved';--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" DROP CONSTRAINT "approval_requests_decision_is_complete";--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "demo"."costed_items" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" ADD CONSTRAINT "approval_requests_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo"."costed_items" ADD CONSTRAINT "costed_items_org_id_branch_id_fk" FOREIGN KEY ("org_id","branch_id") REFERENCES "org"."branches"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_branch_idx" ON "approvals"."approval_requests" USING btree ("org_id","branch_id");--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" ADD CONSTRAINT "approval_requests_decision_is_complete" CHECK (("approvals"."approval_requests"."status" = 'pending' and "approvals"."approval_requests"."decided_by" is null and "approvals"."approval_requests"."decided_at" is null)
          or ("approvals"."approval_requests"."status" = 'cancelled' and "approvals"."approval_requests"."decided_by" is null)
          or ("approvals"."approval_requests"."status"::text = 'auto_approved' and "approvals"."approval_requests"."decided_by" is null and "approvals"."approval_requests"."decided_at" is not null)
          or ("approvals"."approval_requests"."status" in ('approved', 'rejected') and "approvals"."approval_requests"."decided_by" is not null and "approvals"."approval_requests"."decided_at" is not null));--> statement-breakpoint
-- The branch a request is about is part of what was authorised (§6: a branch
-- manager checks their own branch's items). 0009 froze the other terms of a
-- decided request; without this, a request approved by branch A's manager
-- could be re-pointed at branch B afterwards. Same function, one more column.
-- `auto_approved` rows are decided in the same sense and are frozen too, since
-- the trigger lets only `pending` rows change.
create or replace function approvals.freeze_decided_request()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'pending' then
    return new;
  end if;

  if new.type is distinct from old.type
     or new.amount_poisha is distinct from old.amount_poisha
     or new.payload is distinct from old.payload
     or new.requested_by is distinct from old.requested_by
     or new.branch_id is distinct from old.branch_id
     or new.org_id is distinct from old.org_id then
    raise exception
      'approval % is % and its terms cannot change', old.id, old.status
      using errcode = 'integrity_constraint_violation',
            hint = 'Raise a new request rather than editing a decided one.';
  end if;

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
