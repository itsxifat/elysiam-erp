-- What M35a's discounts and flash sales refuse, in the database (D-541, D-542).
--
-- Every rule below is also kept by the service that writes these rows. The duplication is
-- deliberate, as in 0079: a service can be refactored or bypassed, a trigger cannot. Each
-- refusal starts with a code from `packages/contracts/src/errors.ts`, so the module turns
-- it into a 4xx a caller can act on rather than a 500.

-- M16's codes become discounts with the method `code` (0103's defaults). Each is titled
-- with its own word, which is what the console showed for it until now.
update "promo"."codes" set "title" = "code" where "title" = '' and "code" is not null;
--> statement-breakpoint

-- A flash claim is the record of units an order took at a sale price. It is released at
-- most once, when its order is cancelled or returned, and nothing else about it changes:
-- the sale's sold count was moved by exactly these numbers.
create or replace function promo.assert_flash_claim_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'FLASH_CLAIM_IMMUTABLE: a flash claim is released, never removed.';
  end if;
  if old.status <> 'claimed' then
    raise exception 'FLASH_CLAIM_IMMUTABLE: a released flash claim is final.';
  end if;
  if new.status <> 'released' or new.released_at is null then
    raise exception 'FLASH_CLAIM_IMMUTABLE: a flash claim can only be released.';
  end if;
  if (to_jsonb(new) - array['status', 'released_qty', 'released_at', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'released_qty', 'released_at', 'updated_at']) then
    raise exception 'FLASH_CLAIM_IMMUTABLE: only releasing may change a flash claim.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint

create trigger flash_claims_transition
before update or delete on promo.flash_claims
for each row execute function promo.assert_flash_claim_transition();
--> statement-breakpoint

-- A tier belongs to a tiered discount of its own brand; the composite foreign key already
-- keeps the brand, and this keeps the kind.
create or replace function promo.assert_tier_parent() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from promo.codes c
    where c.org_id = new.org_id and c.id = new.code_id and c.kind = 'tiered'
  ) then
    raise exception 'PROMO_INVALID: only a tiered discount has tiers.';
  end if;
  return new;
end;
$$;
--> statement-breakpoint

create trigger discount_tiers_parent
before insert on promo.discount_tiers
for each row execute function promo.assert_tier_parent();
