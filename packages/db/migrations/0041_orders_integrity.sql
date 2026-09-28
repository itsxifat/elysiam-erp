-- Order integrity Drizzle cannot express (M10; architecture §9, invariant 7).
--
-- Invariant 7 says order status changes only through the domain state machine. A pure
-- function in `packages/domain/src/orders/state.ts` is how that is *implemented*; this
-- file is how it is *enforced*. The difference matters because the machine can only
-- refuse the calls that go through it, and the paths that will not are the ones nobody
-- is thinking about when they write them: a data repair, an import, a worker added in
-- M12 that sets a status from a webhook, a future POS sync.
--
-- So §9's transition table is transcribed into a trigger. Fifteen pairs are allowed and
-- an UPDATE that changes `status` to anything else raises. The duplication is the point:
-- two independent statements of the same table, and a milestone that widens one without
-- the other fails loudly rather than shipping a new transition nobody reviewed.
--
-- The rest:
--
-- * `order_events` is append-only in the grants, and a trigger says so for every role —
--   including `erp_owner`, which owns the table and is therefore exempt from the grant.
-- * `orders.order_no` and `orders.org_id` are frozen after insert. A number that can
--   change is a number that already appeared on an invoice, a courier manifest and a
--   customer's SMS.
-- * `order_lines` are frozen once the order has shipped. Editing a shipped order's
--   quantity or price would make its revenue journal, its dispatch movements and its
--   printed invoice describe three different orders, with nothing to say which is right.

CREATE OR REPLACE FUNCTION "sales"."assert_order_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- §9's transition table, verbatim. Kept as a single expression rather than a lookup
  -- table so the whole of it is visible in one place, the way the domain's array is.
  IF NOT (
       (OLD.status = 'pending'             AND NEW.status IN ('confirmed', 'cancelled'))
    OR (OLD.status = 'confirmed'           AND NEW.status IN ('on_hold', 'packed', 'cancelled', 'shipped'))
    OR (OLD.status = 'on_hold'             AND NEW.status = 'confirmed')
    OR (OLD.status = 'packed'              AND NEW.status IN ('cancelled', 'shipped'))
    OR (OLD.status = 'shipped'             AND NEW.status IN ('delivered', 'partially_delivered', 'return_in_transit'))
    OR (OLD.status = 'return_in_transit'   AND NEW.status = 'returned')
    OR (OLD.status = 'partially_delivered' AND NEW.status = 'returned')
    OR (OLD.status = 'delivered'           AND NEW.status = 'exchange')
  ) THEN
    RAISE EXCEPTION
      'ORDER_TRANSITION_INVALID: order % cannot go from % to % (architecture §9)',
      OLD.order_no, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "orders_transition_table"
BEFORE UPDATE OF "status" ON "sales"."orders"
FOR EACH ROW EXECUTE FUNCTION "sales"."assert_order_transition"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales"."assert_order_identity_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id <> OLD.org_id THEN
    -- Moving a row between tenants. RLS would refuse the write itself, but only while
    -- `app.org_id` is set; a migration or the owner role is not so constrained, and an
    -- order that changed org would take its customer, its journals and its stock
    -- movements out of agreement with each other in four different schemas.
    RAISE EXCEPTION 'ORDER_IMMUTABLE: an order cannot change organization'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.order_no <> OLD.order_no THEN
    RAISE EXCEPTION 'ORDER_IMMUTABLE: order number % is already printed and cannot change', OLD.order_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "orders_identity_frozen"
BEFORE UPDATE ON "sales"."orders"
FOR EACH ROW EXECUTE FUNCTION "sales"."assert_order_identity_frozen"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales"."assert_order_line_shape"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status "sales"."order_status";
BEGIN
  SELECT o.status INTO current_status
  FROM "sales"."orders" o
  WHERE o.org_id = COALESCE(NEW.org_id, OLD.org_id)
    AND o.id = COALESCE(NEW.order_id, OLD.order_id);

  IF current_status IS NULL THEN
    -- The order is being deleted and its lines are cascading. Nothing to check.
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF current_status NOT IN ('pending', 'confirmed', 'on_hold') THEN
      RAISE EXCEPTION
        'ORDER_LINES_FROZEN: a % order''s lines cannot be removed', current_status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND current_status NOT IN ('pending', 'confirmed', 'on_hold', 'packed') THEN
    /*
     * A shipped order's commercial terms are fixed.
     *
     * `delivered_qty`, `returned_qty` and `dispatch_unit_cost_poisha` still move — that
     * is how a partial delivery and a return are recorded — but quantity, price and
     * discount are what the revenue journal, the dispatch movements and the invoice in
     * the box were all computed from. Letting one of them change afterwards is the
     * quiet way to make those three disagree with no record of which was right.
     */
    IF NEW.qty <> OLD.qty
       OR NEW.unit_price_poisha <> OLD.unit_price_poisha
       OR NEW.discount_poisha <> OLD.discount_poisha
       OR NEW.sku_id <> OLD.sku_id THEN
      RAISE EXCEPTION
        'ORDER_LINES_FROZEN: order line terms cannot change once the order is %', current_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "order_lines_shape"
BEFORE UPDATE OR DELETE ON "sales"."order_lines"
FOR EACH ROW EXECUTE FUNCTION "sales"."assert_order_line_shape"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sales"."refuse_order_event_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- For every role, including the table's owner. The grants already withhold UPDATE and
  -- DELETE from `erp_app`; this is what makes the append-only claim true of the table
  -- rather than of one role's privileges.
  RAISE EXCEPTION 'ORDER_EVENT_IMMUTABLE: an order''s history is append-only (§9)'
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "order_events_append_only"
BEFORE UPDATE OR DELETE ON "sales"."order_events"
FOR EACH ROW EXECUTE FUNCTION "sales"."refuse_order_event_change"();
