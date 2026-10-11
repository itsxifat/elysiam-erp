-- Tenant isolation and integrity for the inbox's conversation offers (D-748; invariant 4, §5).
--
-- The policy is `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). `inbox.conversation_offers` is offered, then answered once (the trigger below), and
-- never deleted: who declined or let lapse which conversation is what keeps the engine from
-- offering it to the same person twice, like `sales.order_offers` (D-717). No analytics read.

alter table "inbox"."conversation_offers" enable row level security;
--> statement-breakpoint
alter table "inbox"."conversation_offers" force row level security;
--> statement-breakpoint
drop policy if exists "conversation_offers_org_isolation" on "inbox"."conversation_offers";
--> statement-breakpoint
create policy "conversation_offers_org_isolation" on "inbox"."conversation_offers"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."conversation_offers" to "erp_app";
--> statement-breakpoint

-- An offer is answered once: from `offered` to accepted, declined, expired or withdrawn, with
-- the moment it was answered; whom it went to, for which conversation and until when never
-- change, and an answered offer never changes again.
create or replace function "inbox"."assert_conversation_offer_change"() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CONFLICT: a conversation offer is never removed.'
      using errcode = 'check_violation';
  end if;
  if (new.id, new.org_id, new.conversation_id, new.user_id, new.offered_at, new.expires_at,
      new.created_at)
     is distinct from
     (old.id, old.org_id, old.conversation_id, old.user_id, old.offered_at, old.expires_at,
      old.created_at) then
    raise exception 'CONFLICT: a conversation offer''s person, conversation and deadline are fixed.'
      using errcode = 'check_violation';
  end if;
  if old.status <> 'offered' then
    raise exception 'CONFLICT: this offer was already answered.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger "conversation_offers_answered_once"
before update or delete on "inbox"."conversation_offers"
for each row execute function "inbox"."assert_conversation_offer_change"();
