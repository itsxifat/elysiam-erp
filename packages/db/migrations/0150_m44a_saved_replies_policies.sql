-- Tenant isolation for the inbox's saved replies (M44a, D-763; invariant 4, §5), and the one
-- column of an identity the profile job may change (D-761).
--
-- The policy is `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). A saved reply is the brand's own text, edited and removed by whoever holds
-- `update`/`delete SavedReply`; nothing else points at it, so `erp_app` may delete one. No
-- analytics read. The new `inbox.contacts` columns (avatar_url, handle, profile_fetched_at) sit
-- under the table's existing grants and policy (0143).

alter table "inbox"."saved_replies" enable row level security;
--> statement-breakpoint
alter table "inbox"."saved_replies" force row level security;
--> statement-breakpoint
drop policy if exists "saved_replies_org_isolation" on "inbox"."saved_replies";
--> statement-breakpoint
create policy "saved_replies_org_isolation" on "inbox"."saved_replies"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update, delete on "inbox"."saved_replies" to "erp_app";
--> statement-breakpoint

-- D-761: the name Meta gave last is kept on the identity it came with, so a contact's name
-- follows Meta's until a person types one of their own. That column only: an identity's
-- contact, channel and Meta id stay fixed, as 0143 granted no UPDATE at all.
grant update ("profile_name") on "inbox"."identities" to "erp_app";
