-- M38b ledger audit (W2): the packing station's scans are append-only for every role.
--
-- 0130 grants `erp_app` only INSERT and SELECT on `packing.scans`, which holds the app to the
-- rule, but a grant does not bind the table's owner. A scan is the record of what went into a
-- box and who put it there (refusals included, D-610), read back when a buyer says the wrong
-- item arrived; an edited or removed scan would change that record with nothing to notice.
-- So, like `sales.order_events` (0041), a trigger refuses UPDATE and DELETE for every role.
--
-- The guard registry lists `packing.scans` as append-only and `packing.sessions`,
-- `packing.videos` and `packing.settings` as never deleted (`packages/db/src/rls.ts`); 0130's
-- grants already match.

CREATE OR REPLACE FUNCTION "packing"."refuse_scan_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- For every role, including the table's owner. The grants already withhold UPDATE and
  -- DELETE from `erp_app`; this is what makes the append-only claim true of the table
  -- rather than of one role's privileges.
  RAISE EXCEPTION 'CONFLICT: a packing scan is never changed or removed.'
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "scans_append_only"
BEFORE UPDATE OR DELETE ON "packing"."scans"
FOR EACH ROW EXECUTE FUNCTION "packing"."refuse_scan_change"();
