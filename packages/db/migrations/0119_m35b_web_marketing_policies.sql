-- Tenant isolation and integrity for M35b: campaign links, tracking, the ncom.bd connector
-- and the packing scanner (invariant 4, §5, §31; D-550 to D-559).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `storefront.custom_links`: DELETE as well; a campaign link is marketing's to remove, and
--   nothing points at one (D-551).
-- * `storefront.tracking_settings`: one row per brand, edited, never deleted.
-- * `storefront.tracking_events`: the log and the send queue; UPDATE as it is sent, DELETE for
--   the brand's retention purge only (D-552).
-- * `marketplace.ncom_settings`: one row per brand, edited, never deleted.
-- * `marketplace.ncom_holds`, `ncom_orders`, `ncom_outbox`: records; UPDATE along the paths the
--   triggers below allow, never DELETE.
-- * `marketplace.ncom_events`: a claim per webhook event; INSERT and SELECT only.
-- * `packing.scanner_devices`: UPDATE for the last use and the revocation; never DELETE.
--
-- No analytics read on any of them.

alter table "storefront"."custom_links" enable row level security;
--> statement-breakpoint
alter table "storefront"."custom_links" force row level security;
--> statement-breakpoint
drop policy if exists "custom_links_org_isolation" on "storefront"."custom_links";
--> statement-breakpoint
create policy "custom_links_org_isolation" on "storefront"."custom_links"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app";
--> statement-breakpoint
grant select, insert, update, delete on "storefront"."custom_links" to "erp_app";
--> statement-breakpoint
alter table "storefront"."tracking_settings" enable row level security;
--> statement-breakpoint
alter table "storefront"."tracking_settings" force row level security;
--> statement-breakpoint
drop policy if exists "tracking_settings_org_isolation" on "storefront"."tracking_settings";
--> statement-breakpoint
create policy "tracking_settings_org_isolation" on "storefront"."tracking_settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "storefront"."tracking_settings" to "erp_app";
--> statement-breakpoint
alter table "storefront"."tracking_events" enable row level security;
--> statement-breakpoint
alter table "storefront"."tracking_events" force row level security;
--> statement-breakpoint
drop policy if exists "tracking_events_org_isolation" on "storefront"."tracking_events";
--> statement-breakpoint
create policy "tracking_events_org_isolation" on "storefront"."tracking_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app";
--> statement-breakpoint
grant select, insert, update, delete on "storefront"."tracking_events" to "erp_app";
--> statement-breakpoint
alter table "marketplace"."ncom_settings" enable row level security;
--> statement-breakpoint
alter table "marketplace"."ncom_settings" force row level security;
--> statement-breakpoint
drop policy if exists "ncom_settings_org_isolation" on "marketplace"."ncom_settings";
--> statement-breakpoint
create policy "ncom_settings_org_isolation" on "marketplace"."ncom_settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketplace" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "marketplace"."ncom_settings" to "erp_app";
--> statement-breakpoint
alter table "marketplace"."ncom_holds" enable row level security;
--> statement-breakpoint
alter table "marketplace"."ncom_holds" force row level security;
--> statement-breakpoint
drop policy if exists "ncom_holds_org_isolation" on "marketplace"."ncom_holds";
--> statement-breakpoint
create policy "ncom_holds_org_isolation" on "marketplace"."ncom_holds"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketplace" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "marketplace"."ncom_holds" to "erp_app";
--> statement-breakpoint
alter table "marketplace"."ncom_orders" enable row level security;
--> statement-breakpoint
alter table "marketplace"."ncom_orders" force row level security;
--> statement-breakpoint
drop policy if exists "ncom_orders_org_isolation" on "marketplace"."ncom_orders";
--> statement-breakpoint
create policy "ncom_orders_org_isolation" on "marketplace"."ncom_orders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketplace" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "marketplace"."ncom_orders" to "erp_app";
--> statement-breakpoint
alter table "marketplace"."ncom_outbox" enable row level security;
--> statement-breakpoint
alter table "marketplace"."ncom_outbox" force row level security;
--> statement-breakpoint
drop policy if exists "ncom_outbox_org_isolation" on "marketplace"."ncom_outbox";
--> statement-breakpoint
create policy "ncom_outbox_org_isolation" on "marketplace"."ncom_outbox"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketplace" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "marketplace"."ncom_outbox" to "erp_app";
--> statement-breakpoint
alter table "marketplace"."ncom_events" enable row level security;
--> statement-breakpoint
alter table "marketplace"."ncom_events" force row level security;
--> statement-breakpoint
drop policy if exists "ncom_events_org_isolation" on "marketplace"."ncom_events";
--> statement-breakpoint
create policy "ncom_events_org_isolation" on "marketplace"."ncom_events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "marketplace" to "erp_app";
--> statement-breakpoint
grant select, insert on "marketplace"."ncom_events" to "erp_app";
--> statement-breakpoint
alter table "packing"."scanner_devices" enable row level security;
--> statement-breakpoint
alter table "packing"."scanner_devices" force row level security;
--> statement-breakpoint
drop policy if exists "scanner_devices_org_isolation" on "packing"."scanner_devices";
--> statement-breakpoint
create policy "scanner_devices_org_isolation" on "packing"."scanner_devices"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "packing" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "packing"."scanner_devices" to "erp_app";
--> statement-breakpoint

-- A hold is held once and ends once: released (its units given back) or converted (an order
-- ncom handed over took its units over). What it held, where and for which reference is fixed.
create or replace function marketplace.assert_ncom_hold_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.order_ref, new.location_id, new.created_at)
     is distinct from (old.id, old.org_id, old.order_ref, old.location_id, old.created_at) then
    raise exception 'CONFLICT: a marketplace hold names one reference at one place.';
  end if;
  if old.state = 'converted' then
    raise exception 'CONFLICT: a hold an order took over does not change.';
  end if;
  if old.state = new.state and old.state = 'held' and new.lines is distinct from old.lines then
    raise exception 'CONFLICT: a live hold''s lines are fixed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger ncom_holds_path
before update on marketplace.ncom_holds
for each row execute function marketplace.assert_ncom_hold_change();
--> statement-breakpoint

-- An order handed over by ncom is one ncom order, received once under one key; its revision
-- only moves forward.
create or replace function marketplace.assert_ncom_order_change() returns trigger
language plpgsql as $$
begin
  if (new.order_id, new.org_id, new.ncom_order_id, new.idempotency_key, new.received_at,
      new.created_at)
     is distinct from
     (old.order_id, old.org_id, old.ncom_order_id, old.idempotency_key, old.received_at,
      old.created_at) then
    raise exception 'CONFLICT: a handed-over order''s identity is fixed.';
  end if;
  if new.revision < old.revision then
    raise exception 'CONFLICT: a handed-over order''s revision only moves forward.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger ncom_orders_fixed
before update on marketplace.ncom_orders
for each row execute function marketplace.assert_ncom_order_change();
--> statement-breakpoint

-- An outbound message says one thing once: its order, topic, key and revisions are fixed, and
-- once delivered, refused or failed it stays so.
create or replace function marketplace.assert_ncom_outbox_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.order_id, new.topic, new.idempotency_key, new.base_revision,
      new.revision, new.created_at)
     is distinct from
     (old.id, old.org_id, old.order_id, old.topic, old.idempotency_key, old.base_revision,
      old.revision, old.created_at) then
    raise exception 'CONFLICT: an outbound marketplace message is fixed once queued.';
  end if;
  if old.status <> 'pending' then
    raise exception 'CONFLICT: a message already delivered, refused or given up on does not change.';
  end if;
  if new.attempts < old.attempts then
    raise exception 'CONFLICT: a message''s attempts only grow.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger ncom_outbox_path
before update on marketplace.ncom_outbox
for each row execute function marketplace.assert_ncom_outbox_change();
--> statement-breakpoint

-- A scanner device is one person's, in one brand, under one token; revoked once, for good.
create or replace function packing.assert_scanner_device_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.user_id, new.label, new.token_sha256, new.via, new.expires_at,
      new.created_at)
     is distinct from
     (old.id, old.org_id, old.user_id, old.label, old.token_sha256, old.via, old.expires_at,
      old.created_at) then
    raise exception 'CONFLICT: a scanner device''s sign-in is fixed once issued.';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at, new.revoked_by) is distinct from (old.revoked_at, old.revoked_by) then
    raise exception 'CONFLICT: a revoked scanner device stays revoked.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger scanner_devices_fixed
before update on packing.scanner_devices
for each row execute function packing.assert_scanner_device_change();
--> statement-breakpoint

-- A tracked event's identity is fixed; only its sending moves.
create or replace function storefront.assert_tracking_event_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.event_id, new.event_name, new.source, new.order_id,
      new.created_at, new.expires_at)
     is distinct from
     (old.id, old.org_id, old.event_id, old.event_name, old.source, old.order_id,
      old.created_at, old.expires_at) then
    raise exception 'CONFLICT: a tracked event''s identity is fixed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger tracking_events_fixed
before update on storefront.tracking_events
for each row execute function storefront.assert_tracking_event_change();
