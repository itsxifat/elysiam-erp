-- Tenant isolation and integrity for M34: buying on the website (invariant 4, §5, §31;
-- D-520 to D-539).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `notify.email_settings`, `storefront.gateway_settings`: one row per brand, edited; never
--   deleted (switched off instead).
-- * `notify.emails`: the outbox and its log; UPDATE as a send is attempted, never DELETE.
-- * `storefront.customer_accounts`: UPDATE for verification, passwords, the profile and the
--   last sign-in; never DELETE (orders name the row).
-- * `storefront.account_codes`: UPDATE to count a try and to consume; kept for the resend
--   limit; never DELETE.
-- * `storefront.web_orders`: UPDATE only to claim a guest order into an account (the trigger
--   below refuses anything else).
-- * `storefront.order_view_tokens`: INSERT and SELECT only.
-- * `storefront.checkout_submissions`: UPDATE only to name the order the checkout created.
-- * `storefront.payment_sessions`: UPDATE along the path the trigger below allows.
--
-- No analytics read on any of them: nothing in §18 needs another brand's shoppers.

alter table "notify"."email_settings" enable row level security;
--> statement-breakpoint
alter table "notify"."email_settings" force row level security;
--> statement-breakpoint
drop policy if exists "email_settings_org_isolation" on "notify"."email_settings";
--> statement-breakpoint
create policy "email_settings_org_isolation" on "notify"."email_settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "notify" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "notify"."email_settings" to "erp_app";
--> statement-breakpoint
alter table "notify"."emails" enable row level security;
--> statement-breakpoint
alter table "notify"."emails" force row level security;
--> statement-breakpoint
drop policy if exists "emails_org_isolation" on "notify"."emails";
--> statement-breakpoint
create policy "emails_org_isolation" on "notify"."emails"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "notify" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "notify"."emails" to "erp_app";
--> statement-breakpoint
alter table "storefront"."customer_accounts" enable row level security;
--> statement-breakpoint
alter table "storefront"."customer_accounts" force row level security;
--> statement-breakpoint
drop policy if exists "customer_accounts_org_isolation" on "storefront"."customer_accounts";
--> statement-breakpoint
create policy "customer_accounts_org_isolation" on "storefront"."customer_accounts"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."customer_accounts" to "erp_app";
--> statement-breakpoint
alter table "storefront"."account_codes" enable row level security;
--> statement-breakpoint
alter table "storefront"."account_codes" force row level security;
--> statement-breakpoint
drop policy if exists "account_codes_org_isolation" on "storefront"."account_codes";
--> statement-breakpoint
create policy "account_codes_org_isolation" on "storefront"."account_codes"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."account_codes" to "erp_app";
--> statement-breakpoint
alter table "storefront"."web_orders" enable row level security;
--> statement-breakpoint
alter table "storefront"."web_orders" force row level security;
--> statement-breakpoint
drop policy if exists "web_orders_org_isolation" on "storefront"."web_orders";
--> statement-breakpoint
create policy "web_orders_org_isolation" on "storefront"."web_orders"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."web_orders" to "erp_app";
--> statement-breakpoint
alter table "storefront"."order_view_tokens" enable row level security;
--> statement-breakpoint
alter table "storefront"."order_view_tokens" force row level security;
--> statement-breakpoint
drop policy if exists "order_view_tokens_org_isolation" on "storefront"."order_view_tokens";
--> statement-breakpoint
create policy "order_view_tokens_org_isolation" on "storefront"."order_view_tokens"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "storefront"."order_view_tokens" to "erp_app";
--> statement-breakpoint
alter table "storefront"."checkout_submissions" enable row level security;
--> statement-breakpoint
alter table "storefront"."checkout_submissions" force row level security;
--> statement-breakpoint
drop policy if exists "checkout_submissions_org_isolation" on "storefront"."checkout_submissions";
--> statement-breakpoint
create policy "checkout_submissions_org_isolation" on "storefront"."checkout_submissions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."checkout_submissions" to "erp_app";
--> statement-breakpoint
alter table "storefront"."gateway_settings" enable row level security;
--> statement-breakpoint
alter table "storefront"."gateway_settings" force row level security;
--> statement-breakpoint
drop policy if exists "gateway_settings_org_isolation" on "storefront"."gateway_settings";
--> statement-breakpoint
create policy "gateway_settings_org_isolation" on "storefront"."gateway_settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."gateway_settings" to "erp_app";
--> statement-breakpoint
alter table "storefront"."payment_sessions" enable row level security;
--> statement-breakpoint
alter table "storefront"."payment_sessions" force row level security;
--> statement-breakpoint
drop policy if exists "payment_sessions_org_isolation" on "storefront"."payment_sessions";
--> statement-breakpoint
create policy "payment_sessions_org_isolation" on "storefront"."payment_sessions"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "storefront" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "storefront"."payment_sessions" to "erp_app";
--> statement-breakpoint

-- A website order's record is fixed once written; the one change is a guest order joining the
-- account that claimed it (D-523), once.
create or replace function storefront.assert_web_order_change() returns trigger
language plpgsql as $$
begin
  if (new.order_id, new.org_id, new.email, new.locale, new.payment_method, new.phone_e164,
      new.created_at)
     is distinct from
     (old.order_id, old.org_id, old.email, old.locale, old.payment_method, old.phone_e164,
      old.created_at) then
    raise exception 'CONFLICT: a website order''s record is fixed once it is placed.';
  end if;
  if new.account_id is distinct from old.account_id and old.account_id is not null then
    raise exception 'CONFLICT: a website order belongs to one account, once claimed.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger web_orders_fixed
before update on storefront.web_orders
for each row execute function storefront.assert_web_order_change();
--> statement-breakpoint

-- A payment session's terms are fixed and its status moves one way (D-525, D-527):
--
--   initiating -> ready | failed | cancelled | expired
--   ready      -> validating | cancelled | expired | paid | refused
--   validating -> paid | refused | cancelled | expired | validating
--   cancelled  -> validating | paid | refused   (a late valid payment is still recorded)
--   expired    -> validating | paid | refused
--   failed     -> (none)
--   paid, refused: final
create or replace function storefront.assert_payment_session_change() returns trigger
language plpgsql as $$
declare
  edge text;
begin
  if tg_op = 'DELETE' then
    raise exception 'CONFLICT: a payment session is a record and is never removed.';
  end if;
  if (new.id, new.org_id, new.order_id, new.provider, new.mode, new.tran_id, new.amount_poisha,
      new.expires_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.order_id, old.provider, old.mode, old.tran_id, old.amount_poisha,
      old.expires_at, old.created_at) then
    raise exception 'CONFLICT: a payment session''s terms are fixed.';
  end if;
  edge := old.status || '>' || new.status;
  if old.status <> new.status and edge not in (
       'initiating>ready', 'initiating>failed', 'initiating>cancelled', 'initiating>expired',
       'ready>validating', 'ready>cancelled', 'ready>expired', 'ready>paid', 'ready>refused',
       'validating>paid', 'validating>refused', 'validating>cancelled', 'validating>expired',
       'cancelled>validating', 'cancelled>paid', 'cancelled>refused',
       'expired>validating', 'expired>paid', 'expired>refused') then
    raise exception 'CONFLICT: a payment session cannot go from % to %.', old.status, new.status;
  end if;
  if old.status in ('paid', 'refused') then
    raise exception 'CONFLICT: a settled payment session does not change.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger payment_sessions_path
before update or delete on storefront.payment_sessions
for each row execute function storefront.assert_payment_session_change();
--> statement-breakpoint

-- A one-time code is tried, then used once; its hash and its life never change.
create or replace function storefront.assert_account_code_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.account_id, new.purpose, new.code_hash, new.expires_at,
      new.created_at)
     is distinct from
     (old.id, old.org_id, old.account_id, old.purpose, old.code_hash, old.expires_at,
      old.created_at) then
    raise exception 'CONFLICT: a one-time code is fixed once issued.';
  end if;
  if new.attempts < old.attempts then
    raise exception 'CONFLICT: a code''s tries only grow.';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'CONFLICT: a code is used once.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger account_codes_once
before update on storefront.account_codes
for each row execute function storefront.assert_account_code_change();
