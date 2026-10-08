ALTER TABLE "packing"."cameras" DROP CONSTRAINT "packing_cameras_org_name_key";--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD COLUMN "preview_wanted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD CONSTRAINT "cameras_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "packing_cameras_org_name_live_idx" ON "packing"."cameras" USING btree ("org_id","name") WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE "packing"."cameras" ADD CONSTRAINT "packing_cameras_deleted" CHECK (("packing"."cameras"."deleted_at" is null) = ("packing"."cameras"."deleted_by" is null)
          and ("packing"."cameras"."deleted_at" is null or (not "packing"."cameras"."enabled" and "packing"."cameras"."password_sealed" is null)));--> statement-breakpoint
-- D-684: a camera deleted from use stays deleted. The check above keeps it switched off and
-- without a password; this keeps the deletion itself (when, by whom) from being undone.
create or replace function packing.assert_camera_deletion_final() returns trigger
language plpgsql as $$
begin
  if old.deleted_at is not null
     and (new.deleted_at, new.deleted_by) is distinct from (old.deleted_at, old.deleted_by) then
    raise exception 'CONFLICT: a deleted camera stays deleted.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger cameras_deletion_final
before update on packing.cameras
for each row execute function packing.assert_camera_deletion_final();
