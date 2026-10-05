-- M31 (D-476), the ledger audit's second look: an owner never holds an account row.
--
-- An owner signs in by owner link only, and the link's session is made in server code
-- (`createOwnerSession`), never from a credential. So no row in `iam.accounts` — a password,
-- or any other provider — may belong to an owner. That keeps an owner identity, however it
-- came to exist, from ever being reached by a password: not by a credential row written
-- directly, and not by a planted password-reset token, whose redemption writes one.
create or replace function iam.guard_owner_account()
returns trigger
language plpgsql
set search_path = pg_catalog, iam, pg_temp
as $$
begin
  if exists (select 1 from iam.users u where u.id = new.user_id and u.is_owner) then
    raise exception 'OWNER_HAS_NO_PASSWORD: % signs in by owner link only', new.user_id
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
drop trigger if exists accounts_not_for_owners on "iam"."accounts";
--> statement-breakpoint
create trigger accounts_not_for_owners
  before insert or update of user_id on "iam"."accounts"
  for each row execute function iam.guard_owner_account();
