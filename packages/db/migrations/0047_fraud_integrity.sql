-- What the fraud schema refuses, in the database (M13; §5, §10).
--
-- Every rule below is also checked by the service that writes these rows. The
-- duplication is deliberate and it is the same argument invariants 2 and 3 rest
-- on: a service can be refactored, called from a worker, or bypassed by the next
-- module that needs "just one row"; a trigger cannot. Each raises a message
-- beginning with a code from `packages/contracts/src/errors.ts`, so the HTTP layer
-- turns a refusal into a 4xx a client can act on rather than a 500 and a
-- constraint name.
--
-- The first trigger is the one that matters most, and it is not obvious. Every
-- other table in this system is protected by RLS, so the worst a bug can do is
-- refuse. `fraud.phone_signals` has no RLS by design — five orgs write to one row
-- — so the protection has to be about the *key* instead: an UPDATE that changed
-- `phone_hash` would move one person's accumulated history onto another person's
-- number, both rows would still look plausible, and the input cannot be recovered
-- to tell which was right. That is unrecoverable data corruption in the one table
-- that cannot be rebuilt per org, so it is refused outright.

create or replace function fraud.assert_signal_key_stable() returns trigger
language plpgsql as $$
begin
  if new.phone_hash <> old.phone_hash then
    raise exception 'FRAUD_SIGNAL_KEY_IMMUTABLE: a phone signal row is identified by its hash; correct the counts, never the key.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger phone_signals_key_stable
before update of phone_hash on fraud.phone_signals
for each row execute function fraud.assert_signal_key_stable();--> statement-breakpoint

create trigger provider_checks_key_stable
before update of phone_hash on fraud.provider_checks
for each row execute function fraud.assert_signal_key_stable();--> statement-breakpoint

-- An override is evidence, so it is append-only.
--
-- `erp_app` holds no UPDATE or DELETE grant on this table, so in the running
-- application this trigger is unreachable — which is exactly why it is here. The
-- grant protects the application role; the trigger protects the row from
-- `erp_owner`, which is the role a migration, a seed or a data-fix script runs as.
-- "Who approved selling to this blocked buyer" has to answer the same way in a year
-- as it does today.
create or replace function fraud.assert_override_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'FRAUD_OVERRIDE_IMMUTABLE: a fraud override is the record of a decision and cannot be % .', lower(tg_op);
end;
$$;--> statement-breakpoint

create trigger overrides_immutable
before update or delete on fraud.overrides
for each row execute function fraud.assert_override_immutable();--> statement-breakpoint

-- An order's hash mapping cannot change either, for the same reason in a different
-- direction: this row is what the outbox subscriber trusts when it moves a counter
-- four other brands can see. Rewriting it would redirect an order's delivered and
-- returned counts onto somebody else's number.
create or replace function fraud.assert_order_phone_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'FRAUD_ORDER_PHONE_IMMUTABLE: an order keeps the phone hash it was assessed against.';
  end if;
  if new.phone_hash <> old.phone_hash or new.order_id <> old.order_id or new.org_id <> old.org_id then
    raise exception 'FRAUD_ORDER_PHONE_IMMUTABLE: an order keeps the phone hash it was assessed against.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger order_phones_immutable
before update or delete on fraud.order_phones
for each row execute function fraud.assert_order_phone_immutable();--> statement-breakpoint

-- A manual flag has exactly one legitimate transition: standing, then cleared with
-- a reason and an author.
--
-- Without this, UPDATE — which the table needs, because clearing is an update —
-- would also allow rewriting the reason an agent gave, the hash it applies to, or
-- who wrote it. A flag whose text can be changed afterwards is not a record of
-- anybody's judgement, and it is the input to a score that blocks sales.
create or replace function fraud.assert_flag_transition() returns trigger
language plpgsql as $$
begin
  if new.org_id <> old.org_id
    or new.phone_hash <> old.phone_hash
    or new.severity <> old.severity
    or new.reason <> old.reason
    or new.created_by <> old.created_by
  then
    raise exception 'FRAUD_FLAG_IMMUTABLE: a flag may only be cleared; raise a new one to say something different.';
  end if;

  if old.cleared_at is not null then
    raise exception 'FRAUD_FLAG_IMMUTABLE: that flag was already cleared.';
  end if;

  return new;
end;
$$;--> statement-breakpoint

create trigger phone_flags_transition
before update on fraud.phone_flags
for each row execute function fraud.assert_flag_transition();--> statement-breakpoint

-- One rule row per org is a unique constraint (0045); that the row is sane is the
-- check constraints beside it. What neither can express is that the *domain* and the
-- *database* must agree about what sane means, so this function is the third copy of
-- `assertBands` and the only one nothing can go around.
--
-- Stated as a trigger rather than left to the check constraint alone because the
-- error a check constraint raises is a constraint name, and the HTTP layer maps
-- codes. A caller that set warn_min above allow_min should be told what they did.
create or replace function fraud.assert_bands() returns trigger
language plpgsql as $$
begin
  if not (new.allow_min > new.warn_min and new.warn_min > new.require_advance_min) then
    raise exception 'FRAUD_RULES_INVALID: band floors must decrease strictly — allow (%) > warn (%) > require advance (%).',
      new.allow_min, new.warn_min, new.require_advance_min;
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger rules_bands_sane
before insert or update on fraud.rules
for each row execute function fraud.assert_bands();
