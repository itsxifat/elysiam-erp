-- membership_branches -> memberships must carry org_id (D-047).
--
-- Caught by the guard test before this ever reached a commit: a tenant-to-
-- tenant foreign key without org_id can be satisfied by another org's row,
-- because PostgreSQL runs referential-integrity checks with row security
-- bypassed. Here it would have let one org scope a membership to another org's
-- branch — the same hole as org.locations, in new code, two milestones later.
--
-- That is precisely why the guard checks constraint shape rather than trusting
-- that the pattern gets remembered.
--
-- Reordered by hand: Drizzle emits the foreign key before the unique
-- constraint it references, which fails with "there is no unique constraint
-- matching given keys for referenced table".

ALTER TABLE "iam"."memberships" ADD CONSTRAINT "memberships_org_id_id_key" UNIQUE("org_id","id");
--> statement-breakpoint

ALTER TABLE "iam"."membership_branches" DROP CONSTRAINT "membership_branches_membership_id_memberships_id_fk";
--> statement-breakpoint

ALTER TABLE "iam"."membership_branches" ADD CONSTRAINT "membership_branches_org_id_membership_id_fk" FOREIGN KEY ("org_id","membership_id") REFERENCES "iam"."memberships"("org_id","id") ON DELETE cascade ON UPDATE no action;
