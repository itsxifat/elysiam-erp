-- What M16's tables refuse, in the database (M16; architecture §10, invariants 2 and 3).
--
-- Every rule below is also kept by the service that writes these rows. The duplication is
-- deliberate, as in 0070: a service can be refactored or bypassed, a trigger cannot. Each
-- refusal starts with a code from `packages/contracts/src/errors.ts`, so the module turns
-- it into a 4xx a caller can act on rather than a 500.

-- The promo code on an order names a code of the same brand. Here rather than in the
-- Drizzle schema because `promo` already imports the orders schema, and a declaration in
-- both directions would be an import cycle. Composite, like every tenant foreign key, so
-- an order cannot point at another brand's code (D-047).
alter table "sales"."orders"
  add constraint "orders_org_id_promo_code_id_fk"
  foreign key ("org_id", "promo_code_id")
  references "promo"."codes" ("org_id", "id")
  on delete restrict;--> statement-breakpoint

-- A redemption is the record of a discount a buyer was given. It is released once, when
-- its order is cancelled before it ships, and nothing else about it ever changes: the
-- order's discount and the books were built from these amounts.
create or replace function promo.assert_redemption_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'PROMO_REDEMPTION_IMMUTABLE: a redemption is released, never removed.';
  end if;
  if old.status <> 'applied' then
    raise exception 'PROMO_REDEMPTION_IMMUTABLE: a released redemption is final.';
  end if;
  if new.status <> 'released' or new.released_at is null then
    raise exception 'PROMO_REDEMPTION_IMMUTABLE: an applied redemption can only be released.';
  end if;
  if (to_jsonb(new) - array['status', 'released_at', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'released_at', 'updated_at']) then
    raise exception 'PROMO_REDEMPTION_IMMUTABLE: only releasing may change a redemption.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger promo_redemptions_transition
before update or delete on promo.redemptions
for each row execute function promo.assert_redemption_transition();--> statement-breakpoint

-- An issued greeting is what stops the daily job greeting the same buyer twice in a year.
-- Removing or editing one would let the job run again, so neither is possible.
create or replace function sales.refuse_occasion_issue_change() returns trigger
language plpgsql as $$
begin
  raise exception 'CRM_OCCASION_IMMUTABLE: an issued greeting is permanent.';
end;
$$;--> statement-breakpoint

create trigger occasion_issues_immutable
before update or delete on sales.occasion_issues
for each row execute function sales.refuse_occasion_issue_change();--> statement-breakpoint

-- A message that went out stays in the log as sent. The send job records an outcome
-- once; a sent row rewritten as failed would make the log say a buyer was not texted
-- when they were.
create or replace function notify.assert_message_outcome() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'NOTIFY_MESSAGE_IMMUTABLE: the delivery log keeps every message.';
  end if;
  if old.state in ('sent', 'suppressed') then
    raise exception 'NOTIFY_MESSAGE_IMMUTABLE: a sent or suppressed message is final.';
  end if;
  if (to_jsonb(new) - array['state', 'attempts', 'send_after', 'provider',
                             'provider_message_id', 'error', 'sent_at', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['state', 'attempts', 'send_after', 'provider',
                             'provider_message_id', 'error', 'sent_at', 'updated_at']) then
    raise exception 'NOTIFY_MESSAGE_IMMUTABLE: only the send outcome may change.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger notify_messages_outcome
before update or delete on notify.messages
for each row execute function notify.assert_message_outcome();
