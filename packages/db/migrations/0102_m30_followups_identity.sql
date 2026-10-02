-- m30-followups (D-412, M30's A5): who has ever held a role in another brand.
--
-- `POST /v1/users` reuses an existing identity when the address is already known. If that
-- identity has ever held a role in another brand, one brand's admin could have created it
-- and set its password through the invite they were handed, and the second brand's role
-- would then open with a password the first brand's admin knows. So adding such a person
-- is a super admin's, and the check runs inside the transaction that grants the role,
-- after the person lock, so a parallel add in the other brand cannot slip between them.
--
-- Like `iam.users_active_elsewhere` (0101), it looks through each person's own lens (the
-- D-050 self policy): the acting admin's org context cannot see another brand's rows,
-- which is the point of it. It returns ids, never a brand. Unlike it, a revoked role and
-- a closed brand count: "was one of another brand's people" is the fact that matters.
create or replace function iam.users_held_elsewhere(p_users text[], p_org uuid)
returns setof text
language plpgsql
volatile
security invoker
set search_path = pg_catalog, iam
as $$
declare
  v_previous text := coalesce(current_setting('app.user_id', true), '');
  v_user text;
begin
  foreach v_user in array coalesce(p_users, '{}'::text[]) loop
    perform set_config('app.user_id', v_user, true);
    if exists (
      select 1
      from iam.memberships m
      where m.user_id = v_user and m.org_id <> p_org
    ) then
      return next v_user;
    end if;
  end loop;
  perform set_config('app.user_id', v_previous, true);
  return;
end;
$$;
--> statement-breakpoint
revoke all on function iam.users_held_elsewhere(text[], uuid) from public;
--> statement-breakpoint
grant execute on function iam.users_held_elsewhere(text[], uuid) to "erp_app";
