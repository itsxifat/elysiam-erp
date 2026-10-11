-- When a second factor was set up (M40, D-698), stamped by the database.
--
-- Better Auth writes `iam.two_factors` through its own adapter and knows nothing of
-- `enabled_at`, so the stamp cannot come from the code that writes the row. A BEFORE trigger
-- sets it whenever the factor becomes verified (Better Auth's verify-totp after enrolment, or
-- a row born verified) and whenever the secret changes on a verified factor (My account's
-- "set up on a new phone"). A pending row (`verified = false`) carries no date; a factor set up
-- before this migration keeps NULL, which My account shows as "not recorded". The trigger only
-- touches NEW, so it needs no grant beyond what erp_app already holds on the table.
create or replace function iam.stamp_two_factor_enabled_at()
returns trigger
language plpgsql
set search_path = pg_catalog, iam
as $$
begin
  if not new.verified then
    new.enabled_at := null;
  elsif tg_op = 'INSERT'
     or not old.verified
     or new.secret is distinct from old.secret then
    new.enabled_at := now();
  else
    new.enabled_at := old.enabled_at;
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists two_factors_stamp_enabled_at on "iam"."two_factors";
--> statement-breakpoint
create trigger two_factors_stamp_enabled_at
  before insert or update on "iam"."two_factors"
  for each row execute function iam.stamp_two_factor_enabled_at();
