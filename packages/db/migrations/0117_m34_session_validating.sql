-- M34 ledger audit W1 (D-527): a session is `validating` from the moment a return or an IPN
-- names a `val_id` until the gateway has answered, so the unpaid-order timer and a shopper's
-- "fail" cannot cancel an order whose payment is being checked. A payment the gateway calls
-- not valid puts the session back to `ready` while its page may still be paid, else to
-- `expired` — `validating -> ready` is the one new edge.
--
--   initiating -> ready | failed | cancelled | expired
--   ready      -> validating | cancelled | expired | paid | refused
--   validating -> ready | paid | refused | cancelled | expired
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
       'validating>ready', 'validating>paid', 'validating>refused', 'validating>cancelled',
       'validating>expired',
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
