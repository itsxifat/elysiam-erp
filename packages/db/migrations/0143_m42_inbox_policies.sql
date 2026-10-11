-- Tenant isolation and integrity for M42: the unified inbox (invariant 4; D-730 to D-749).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `settings`, `channels`: the brand's Meta app and channels, written and edited, never deleted
--   (a channel is switched off instead).
-- * `contacts`, `conversations`: written and edited; never deleted (the record of who wrote).
-- * `identities`: a PSID, IGSID or wa_id, inserted once; INSERT and SELECT only.
-- * `messages`: inserted, then only an outbound message's delivery fields move (trigger below).
-- * `notes`: dated and signed; INSERT and SELECT only.
-- * `interests`: added and removed.
-- * `webhook_events`: stored, then marked processed with the body cleared (trigger below).
--
-- No analytics read on any of them.

alter table "inbox"."settings" enable row level security;
--> statement-breakpoint
alter table "inbox"."settings" force row level security;
--> statement-breakpoint
drop policy if exists "settings_org_isolation" on "inbox"."settings";
--> statement-breakpoint
create policy "settings_org_isolation" on "inbox"."settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "inbox" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "inbox"."settings" to "erp_app";
--> statement-breakpoint
alter table "inbox"."channels" enable row level security;
--> statement-breakpoint
alter table "inbox"."channels" force row level security;
--> statement-breakpoint
drop policy if exists "channels_org_isolation" on "inbox"."channels";
--> statement-breakpoint
create policy "channels_org_isolation" on "inbox"."channels"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."channels" to "erp_app";
--> statement-breakpoint
alter table "inbox"."contacts" enable row level security;
--> statement-breakpoint
alter table "inbox"."contacts" force row level security;
--> statement-breakpoint
drop policy if exists "contacts_org_isolation" on "inbox"."contacts";
--> statement-breakpoint
create policy "contacts_org_isolation" on "inbox"."contacts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."contacts" to "erp_app";
--> statement-breakpoint
alter table "inbox"."identities" enable row level security;
--> statement-breakpoint
alter table "inbox"."identities" force row level security;
--> statement-breakpoint
drop policy if exists "identities_org_isolation" on "inbox"."identities";
--> statement-breakpoint
create policy "identities_org_isolation" on "inbox"."identities"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on "inbox"."identities" to "erp_app";
--> statement-breakpoint
alter table "inbox"."conversations" enable row level security;
--> statement-breakpoint
alter table "inbox"."conversations" force row level security;
--> statement-breakpoint
drop policy if exists "conversations_org_isolation" on "inbox"."conversations";
--> statement-breakpoint
create policy "conversations_org_isolation" on "inbox"."conversations"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."conversations" to "erp_app";
--> statement-breakpoint
alter table "inbox"."messages" enable row level security;
--> statement-breakpoint
alter table "inbox"."messages" force row level security;
--> statement-breakpoint
drop policy if exists "messages_org_isolation" on "inbox"."messages";
--> statement-breakpoint
create policy "messages_org_isolation" on "inbox"."messages"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."messages" to "erp_app";
--> statement-breakpoint
alter table "inbox"."notes" enable row level security;
--> statement-breakpoint
alter table "inbox"."notes" force row level security;
--> statement-breakpoint
drop policy if exists "notes_org_isolation" on "inbox"."notes";
--> statement-breakpoint
create policy "notes_org_isolation" on "inbox"."notes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert on "inbox"."notes" to "erp_app";
--> statement-breakpoint
alter table "inbox"."interests" enable row level security;
--> statement-breakpoint
alter table "inbox"."interests" force row level security;
--> statement-breakpoint
drop policy if exists "interests_org_isolation" on "inbox"."interests";
--> statement-breakpoint
create policy "interests_org_isolation" on "inbox"."interests"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, delete on "inbox"."interests" to "erp_app";
--> statement-breakpoint
alter table "inbox"."webhook_events" enable row level security;
--> statement-breakpoint
alter table "inbox"."webhook_events" force row level security;
--> statement-breakpoint
drop policy if exists "webhook_events_org_isolation" on "inbox"."webhook_events";
--> statement-breakpoint
create policy "webhook_events_org_isolation" on "inbox"."webhook_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "inbox"."webhook_events" to "erp_app";
--> statement-breakpoint

-- A message is what was said: its conversation, direction, words, attachments, author and time
-- never change. Only an outbound message's delivery moves (status, Meta's id once, the times and
-- the error), and an inbound one changes not at all (D-735, D-746).
create or replace function inbox.assert_message_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.conversation_id, new.direction, new.body, new.attachments,
      new.sent_by, new.occurred_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.conversation_id, old.direction, old.body, old.attachments,
      old.sent_by, old.occurred_at, old.created_at) then
    raise exception 'CONFLICT: a message''s words, author and time are fixed.';
  end if;
  if old.direction = 'inbound' and row(new.*) is distinct from row(old.*) then
    raise exception 'CONFLICT: a received message does not change.';
  end if;
  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'CONFLICT: a message''s provider id is set once.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger messages_path
before update on inbox.messages
for each row execute function inbox.assert_message_change();
--> statement-breakpoint

-- A stored webhook body is what Meta sent: its brand, object, hash and arrival are fixed, the
-- body may only be cleared (once processed), and a processed event is not processed again.
create or replace function inbox.assert_webhook_event_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.object, new.body_sha256, new.received_at)
     is distinct from (old.id, old.org_id, old.object, old.body_sha256, old.received_at) then
    raise exception 'CONFLICT: a stored webhook''s origin is fixed.';
  end if;
  if new.body is not null and new.body is distinct from old.body then
    raise exception 'CONFLICT: a stored webhook body is only ever cleared.';
  end if;
  if old.processed_at is not null and new.processed_at is distinct from old.processed_at then
    raise exception 'CONFLICT: a webhook is processed once.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger webhook_events_path
before update on inbox.webhook_events
for each row execute function inbox.assert_webhook_event_change();
