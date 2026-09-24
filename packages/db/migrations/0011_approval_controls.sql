ALTER TYPE "approvals"."approval_type" ADD VALUE 'threshold_change';--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" ADD COLUMN "threshold_poisha" bigint;--> statement-breakpoint
-- NOT VALID: new and updated rows are checked from here on, but a database
-- that already holds an auto-approved period_reopen (the D-071 attack) can
-- still migrate. Those rows are frozen by the 0009 trigger and cannot be
-- repaired in place; they are evidence, and an operator reviews them with
-- `alter table … validate constraint approval_requests_never_auto_approved`.
ALTER TABLE "approvals"."approval_requests" ADD CONSTRAINT "approval_requests_never_auto_approved" CHECK ("approvals"."approval_requests"."status"::text <> 'auto_approved' or "approvals"."approval_requests"."type"::text not in ('period_reopen', 'bonus_rule', 'threshold_change', 'back_dated_entry')) NOT VALID;--> statement-breakpoint
-- A threshold on a control type was only ever a way to switch its checker off
-- (D-071), and a negative one is meaningless. Neither is kept.
DELETE FROM "approvals"."approval_thresholds" WHERE "type"::text in ('period_reopen', 'bonus_rule', 'threshold_change', 'back_dated_entry') OR "threshold_poisha" < 0;--> statement-breakpoint
ALTER TABLE "approvals"."approval_thresholds" ADD CONSTRAINT "approval_thresholds_never_for_controls" CHECK ("approvals"."approval_thresholds"."type"::text not in ('period_reopen', 'bonus_rule', 'threshold_change', 'back_dated_entry'));--> statement-breakpoint
ALTER TABLE "approvals"."approval_thresholds" ADD CONSTRAINT "approval_thresholds_not_negative" CHECK ("approvals"."approval_thresholds"."threshold_poisha" >= 0);--> statement-breakpoint
-- The terms of a request are fixed from the moment it is raised, and only a
-- checker's decision moves a request out of `pending` (security re-audit W3).
--
-- 0009/0010 froze a request once decided but let a *pending* row be edited
-- freely, which undid maker-checker from the other end:
--
--   * `update … set status = 'auto_approved'` on a pending row skipped the
--     checker outright — the CHECK constraints allow that shape;
--   * `update … set requested_by = <someone else>` on a pending row made the
--     real requester a legitimate "different person", who then approved it;
--   * the amount, payload, type or branch could be changed after a checker
--     had looked but before they clicked.
--
-- So: every term is immutable on every row, `auto_approved` can only be
-- written by INSERT (the service, below the threshold), and a decided row
-- stays decided.
create or replace function approvals.freeze_decided_request()
returns trigger
language plpgsql
as $$
begin
  if new.type is distinct from old.type
     or new.amount_poisha is distinct from old.amount_poisha
     or new.threshold_poisha is distinct from old.threshold_poisha
     or new.payload is distinct from old.payload
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
       or new.decided_at is distinct from old.decided_at) then
    raise exception
      'approval % is already %', old.id, old.status
      using errcode = 'integrity_constraint_violation',
            hint = 'A decision is final. Raise a new request.';
  end if;

  return new;
end;
$$;
