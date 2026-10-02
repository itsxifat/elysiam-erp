-- Tenant isolation and integrity for M17's two tables (invariants 2 and 4, §5, §7, §9).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo
-- is (D-048). The grants are where the decisions are:
--
-- * `sales.order_advances`: UPDATE, because a claim is decided and then ended; never DELETE.
--   The trigger below says which updates.
-- * `sales.order_returns`: INSERT and SELECT only. A reason is recorded once, with the return.
--
-- No analytics read on either.

alter table "sales"."order_advances" enable row level security;
--> statement-breakpoint
alter table "sales"."order_advances" force row level security;
--> statement-breakpoint
drop policy if exists "order_advances_org_isolation" on "sales"."order_advances";
--> statement-breakpoint
create policy "order_advances_org_isolation" on "sales"."order_advances"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert, update on "sales"."order_advances" to "erp_app";
--> statement-breakpoint
alter table "sales"."order_returns" enable row level security;
--> statement-breakpoint
alter table "sales"."order_returns" force row level security;
--> statement-breakpoint
drop policy if exists "order_returns_org_isolation" on "sales"."order_returns";
--> statement-breakpoint
create policy "order_returns_org_isolation" on "sales"."order_returns"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "sales" to "erp_app", "erp_analytics";
--> statement-breakpoint
grant select, insert on "sales"."order_returns" to "erp_app";
--> statement-breakpoint

-- An advance's path (D-230 to D-233). The service keeps every rule below too; a trigger is
-- what a refactor or a hand-written UPDATE cannot walk around. Each refusal starts with a
-- code from `packages/contracts/src/errors.ts`.
--
--   pending    → verified | rejected                 (accounts decides, once)
--   verified   → verified                            (a partial delivery used some of it)
--   verified   → applied | refund_due | forfeited    (the order ended)
--   refund_due → refunded                            (the money went back)
--   verified   → voided                              (a mistaken verification undone, D-236)
create or replace function sales.assert_order_advance_change() returns trigger
language plpgsql as $$
declare
  edge text;
begin
  if tg_op = 'DELETE' then
    raise exception 'ADVANCE_IMMUTABLE: an advance is never removed; reject it or settle it.';
  end if;

  if (new.id, new.org_id, new.order_id, new.method, new.transaction_ref, new.amount_poisha,
      new.note, new.recorded_by, new.recorded_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.order_id, old.method, old.transaction_ref, old.amount_poisha,
      old.note, old.recorded_by, old.recorded_at, old.created_at) then
    raise exception 'ADVANCE_IMMUTABLE: a claim''s terms are fixed once it is recorded.';
  end if;

  edge := old.status || '>' || new.status;
  if edge not in ('pending>verified', 'pending>rejected', 'verified>verified',
                  'verified>applied', 'verified>refund_due', 'verified>forfeited',
                  'refund_due>refunded', 'verified>voided') then
    raise exception 'ADVANCE_IMMUTABLE: an advance cannot go from % to %.', old.status, new.status;
  end if;
  if edge = 'verified>voided' and old.applied_poisha <> 0 then
    raise exception 'ADVANCE_IMMUTABLE: a delivery used this advance, so it cannot be voided.';
  end if;

  -- The decision is made once, by whoever made it, into the wallet they named.
  if old.status <> 'pending'
     and (new.decided_by, new.decided_at, new.reject_reason, new.wallet_account_id,
          new.received_journal_id)
         is distinct from
         (old.decided_by, old.decided_at, old.reject_reason, old.wallet_account_id,
          old.received_journal_id) then
    raise exception 'ADVANCE_IMMUTABLE: a verified or rejected claim stays decided.';
  end if;

  -- What deliveries used only grows, and only while the advance is held.
  if new.applied_poisha < old.applied_poisha
     or (new.applied_poisha <> old.applied_poisha
         and not (old.status = 'verified' and new.status in ('verified', 'applied'))) then
    raise exception 'ADVANCE_IMMUTABLE: an applied amount only grows, and only on delivery.';
  end if;
  if edge = 'verified>verified' and new.applied_poisha = old.applied_poisha then
    raise exception 'ADVANCE_IMMUTABLE: nothing about a held advance changes but what was applied.';
  end if;

  -- What the brand kept is decided by the ending, once.
  if (new.kept_poisha, new.kept_journal_id) is distinct from (old.kept_poisha, old.kept_journal_id)
     and edge not in ('verified>refund_due', 'verified>forfeited') then
    raise exception 'ADVANCE_IMMUTABLE: only the order''s ending keeps any of an advance.';
  end if;

  -- A refund is written once, by the move that records it.
  if (new.refund_journal_id, new.refund_wallet_account_id, new.refund_ref)
     is distinct from (old.refund_journal_id, old.refund_wallet_account_id, old.refund_ref)
     and edge <> 'refund_due>refunded' then
    raise exception 'ADVANCE_IMMUTABLE: only a recorded refund writes a refund.';
  end if;
  if (new.settled_by, new.settled_at) is distinct from (old.settled_by, old.settled_at)
     and edge not in ('verified>forfeited', 'refund_due>refunded') then
    raise exception 'ADVANCE_IMMUTABLE: an advance is settled once.';
  end if;

  -- A void is written once, by the move that voids.
  if (new.void_journal_id, new.void_reason, new.voided_by, new.voided_at)
     is distinct from (old.void_journal_id, old.void_reason, old.voided_by, old.voided_at)
     and edge <> 'verified>voided' then
    raise exception 'ADVANCE_IMMUTABLE: only voiding a verification writes a void.';
  end if;

  return new;
end;
$$;
--> statement-breakpoint
create trigger order_advances_path
before update or delete on sales.order_advances
for each row execute function sales.assert_order_advance_change();
--> statement-breakpoint

-- Every advance is born a claim: pending, nothing applied or kept, no decision, no journal.
-- The path above is then the only way to anything else, so no row can arrive already
-- "verified" without the verification that posts its journal.
create or replace function sales.assert_order_advance_born_pending() returns trigger
language plpgsql as $$
begin
  if new.status <> 'pending' or new.applied_poisha <> 0 or new.kept_poisha <> 0
     or num_nonnulls(new.decided_by, new.decided_at, new.reject_reason, new.wallet_account_id,
                     new.received_journal_id, new.kept_journal_id, new.settled_by,
                     new.settled_at, new.refund_journal_id, new.refund_wallet_account_id,
                     new.refund_ref, new.void_journal_id, new.void_reason, new.voided_by,
                     new.voided_at) > 0 then
    raise exception 'ADVANCE_IMMUTABLE: an advance is recorded as a pending claim.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger order_advances_born_pending
before insert on sales.order_advances
for each row execute function sales.assert_order_advance_born_pending();
--> statement-breakpoint

-- A recorded return reason is permanent: the report is built from it.
create or replace function sales.refuse_order_return_change() returns trigger
language plpgsql as $$
begin
  raise exception 'ORDER_RETURN_REASON_REQUIRED: a recorded return reason is permanent.';
end;
$$;
--> statement-breakpoint
create trigger order_returns_immutable
before update or delete on sales.order_returns
for each row execute function sales.refuse_order_return_change();
--> statement-breakpoint

-- M17 check 3 in the database: an order that moves into `returned` or `exchange` has its
-- reason by the time the transaction commits. Deferred, because the status change and the
-- reason row are written by the same transition in either order. The domain machine refuses
-- the move without a reason first; this is the floor under anything that bypasses it.
create or replace function sales.assert_return_reason_recorded() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from sales.order_returns r where r.org_id = new.org_id and r.order_id = new.id
  ) then
    raise exception 'ORDER_RETURN_REASON_REQUIRED: order % became % with no return reason.',
      new.order_no, new.status;
  end if;
  return null;
end;
$$;
--> statement-breakpoint
create constraint trigger orders_return_reason_recorded
after update of status on sales.orders
deferrable initially deferred
for each row
when (new.status in ('returned', 'exchange') and old.status is distinct from new.status)
execute function sales.assert_return_reason_recorded();
