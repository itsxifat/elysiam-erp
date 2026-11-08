ALTER TABLE "inventory"."adjustments" ADD COLUMN "cause" text DEFAULT 'shrinkage' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD COLUMN "correction_journal_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_org_id_correction_journal_id_fk" FOREIGN KEY ("org_id","correction_journal_id") REFERENCES "ledger"."journals"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_cause" CHECK ("inventory"."adjustments"."cause" in ('shrinkage', 'opening_correction'));--> statement-breakpoint
ALTER TABLE "inventory"."adjustments" ADD CONSTRAINT "adjustments_correction_shape" CHECK ("inventory"."adjustments"."correction_journal_id" is null or ("inventory"."adjustments"."status" = 'posted' and "inventory"."adjustments"."cause" = 'opening_correction'));--> statement-breakpoint

-- D-955: an adjustment is either a real loss or find (`shrinkage`, through profit) or a fix
-- to the stock in hand entered at the start (`opening_correction`, to opening equity). The
-- second is a change to the opening figures, so it is allowed only while the brand's opening
-- stock window is open, exactly like a stock in hand entry and its reversal (0114).
--
-- 0033's freeze rules stay, with two more: the cause is fixed, except for the one change a
-- posted write-off may take (shrinkage → opening_correction, naming the journal that posts
-- it to opening equity, while the window is open), and that journal, once named, never
-- changes.
create or replace function inventory.freeze_adjustment() returns trigger
language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id
     or new.location_id is distinct from old.location_id
     or new.branch_id is distinct from old.branch_id
     or new.direction is distinct from old.direction
     or new.value_poisha is distinct from old.value_poisha
     or new.count_session_id is distinct from old.count_session_id
     or new.business_date is distinct from old.business_date
     or new.approval_request_id is distinct from old.approval_request_id
     or new.created_by is distinct from old.created_by then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: an adjustment''s terms are fixed when its approval is raised.';
  end if;

  if old.status <> 'pending_approval' and new.status is distinct from old.status then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: this adjustment is already %.', old.status;
  end if;
  if old.status = 'pending_approval' and new.status not in ('pending_approval', 'posted', 'rejected') then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: an adjustment is posted or rejected, nothing else.';
  end if;
  -- A posted adjustment names its journal, and that journal never changes
  -- (invariant 2), so re-pointing it would be a second correction with no record.
  if old.journal_id is not null and new.journal_id is distinct from old.journal_id then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: this adjustment already names a journal.';
  end if;

  if old.correction_journal_id is not null
     and new.correction_journal_id is distinct from old.correction_journal_id then
    raise exception 'STOCK_ADJUSTMENT_FROZEN: this adjustment is already an opening correction.';
  end if;
  if new.cause is distinct from old.cause or new.correction_journal_id is distinct from old.correction_journal_id then
    if not (old.cause = 'shrinkage' and new.cause = 'opening_correction'
            and old.status = 'posted' and new.status = 'posted'
            and old.correction_journal_id is null and new.correction_journal_id is not null) then
      raise exception 'STOCK_ADJUSTMENT_FROZEN: only a posted write-off or gain can be found to be an opening correction, once.';
    end if;
    perform inventory.assert_opening_window_open(new.org_id);
  end if;

  -- An opening correction posts while the window is open, and not after.
  if new.cause = 'opening_correction' and old.status = 'pending_approval' and new.status = 'posted' then
    perform inventory.assert_opening_window_open(new.org_id);
  end if;

  return new;
end;
$$;--> statement-breakpoint

create or replace function inventory.assert_adjustment_cause_window() returns trigger
language plpgsql as $$
begin
  if new.cause = 'opening_correction' then
    perform inventory.assert_opening_window_open(new.org_id);
  end if;
  return new;
end;
$$;--> statement-breakpoint

drop trigger if exists adjustments_cause_window on inventory.adjustments;--> statement-breakpoint
create trigger adjustments_cause_window
before insert on inventory.adjustments
for each row execute function inventory.assert_adjustment_cause_window();
