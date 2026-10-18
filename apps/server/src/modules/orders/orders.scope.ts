import { rowInScope, scopeFilterFor, type ScopedRow } from '@elysium/contracts';
import type { RequestContext } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

import { filterWhere, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';

/**
 * §6's scope for orders, as SQL.
 *
 * The sales cell reads "own + unassigned queue", and the queue is added **only** for a
 * caller who actually holds `sales`. `reseller` holds the same `own` grants and must not
 * gain the queue with them: a reseller seeing every unassigned staff order is a
 * cross-tenant-shaped leak inside one org.
 *
 * Since D-725 a sales agent **reads** every order of the brand (`read Order` at `org`): a
 * colleague's order opens with "Handled by …" over it. What they may **act** on is unchanged:
 * `create` and `update Order` stay at `own`, which with the queue is "own + unassigned"; a
 * colleague's order is reached only by the desk's acts, through the owner's acknowledgement
 * (`deskActScopeSql`).
 *
 * Exported because the document endpoints answer the same question — an invoice is the
 * whole order in a form that can be forwarded — and two definitions of "may this caller
 * see this order" is one definition too many.
 */
export function orderScopeSql(context: ActiveContext, request: object): SQL {
  const base = scopeWhere(request, COLUMNS);
  return withQueue(context, base);
}

/**
 * The same scope for a caller whose route declared another subject (M42, D-740): `read Order`
 * computed from the caller's own context, with the sales queue added the way `orderScopeSql`
 * adds it. The inbox's customer panel lists a buyer's orders through this, as the buyer profile
 * lists them through `orderScopeSql`.
 */
export function orderReadScopeFor(context: RequestContext): SQL {
  return withQueue(
    context,
    filterWhere(scopeFilterFor(context, 'read', 'Order'), COLUMNS, 'Order'),
  );
}

/**
 * The orders a queue lists (D-725): the ones the caller may work on, `update Order` from the
 * caller's own context plus the sales queue. For every role but sales that is the read scope;
 * for a sales agent it is their own orders and the unassigned ones, so the desk's and the hub's
 * tabs stay theirs while the plain list shows the brand. A role that reads orders but never
 * works one (accounts, marketing, a reseller) has queues of what it reads: nothing narrows.
 */
export function orderActScopeFor(context: RequestContext): SQL {
  const filter = scopeFilterFor(context, 'update', 'Order');
  if (filter.kind === 'none') return sql`true`;
  return withQueue(context, filterWhere(filter, COLUMNS, 'Order'));
}

/** Whether one order is among those `orderActScopeFor` reaches, for a view that has the row. */
export function orderInActScope(context: RequestContext, row: ScopedRow): boolean {
  if (context.roles.includes('sales') && (row.assignedTo ?? null) === null) return true;
  return rowInScope(scopeFilterFor(context, 'update', 'Order'), row);
}

/**
 * The scope a desk act locks its order in (M41 D-710, D-725): the route's own, widened by what
 * the **sales** role reads, and only for a caller who holds sales. A sales agent therefore
 * reaches a colleague's order with an edit, a confirm, a hold, a cancel, an exchange, a call or
 * an advance claim, and the owner's gate is what stands in the way: `ORDER_HANDLED_BY_OTHER`
 * until they acknowledge the owner, who is then told. An unassigned order needs no gate, and
 * sales already acts on every one of those (§6's queue), so the widening reaches only orders
 * somebody holds. The hub's moves keep the route's scope (`orderScopeSql`): nobody packs or
 * ships a colleague's order from the sales desk.
 *
 * Not the caller's whole read scope: a person holding several roles (a branch manager who is
 * also accounts or marketing, both `read Order` at `org`) would then act gate-free on any
 * unassigned order of any branch (the ledger audit of D-725). Only sales' own read rule widens.
 */
export function deskActScopeSql(context: ActiveContext, request: object): SQL {
  const route = orderScopeSql(context, request);
  if (!context.roles.includes('sales')) return route;
  const salesRead = filterWhere(
    scopeFilterFor({ ...context, roles: ['sales'] }, 'read', 'Order'),
    COLUMNS,
    'Order',
  );
  return sql`(${route} or ${salesRead})`;
}

/**
 * The desk act scope of `deskActScopeSql`, computed from the caller's own context rather than the
 * route's (M47, D-834): a phone call's route declares `PhoneCall`, not `Order`, so the order is
 * locked in the caller's own `update Order` (with the sales queue), widened by what sales reads
 * for a caller who holds sales. A role with no `update Order` reaches no order this way.
 */
export function deskActScopeFor(context: RequestContext): SQL {
  const own = withQueue(
    context,
    filterWhere(scopeFilterFor(context, 'update', 'Order'), COLUMNS, 'Order'),
  );
  if (!context.roles.includes('sales')) return own;
  const salesRead = filterWhere(
    scopeFilterFor({ ...context, roles: ['sales'] }, 'read', 'Order'),
    COLUMNS,
    'Order',
  );
  return sql`(${own} or ${salesRead})`;
}

/**
 * The buyers a caller may open, over their orders (M42, D-740; kept by D-725): `read Customer`
 * mapped onto the orders, "customers of own orders", plus the sales queue. The inbox links a
 * phone typed into a chat only to such a buyer. Not the read scope for orders, which since D-725
 * reaches every order of the brand for a sales agent: reading a colleague's order does not make
 * its buyer the agent's.
 */
export function buyerReachScopeFor(context: RequestContext): SQL {
  return withQueue(
    context,
    filterWhere(scopeFilterFor(context, 'read', 'Customer'), COLUMNS, 'Customer'),
  );
}

/**
 * The buyers whose pinned note a caller may change (M47, D-860): `update Customer` from the
 * caller's own context, mapped onto the buyer's orders as `buyerReachScopeFor` maps `read`, with
 * the sales queue. For sales, read and update Customer are both `own`, so it is the buyers they
 * reach; a supervisor reaches theirs by their grant; a role with no `update Customer` none. No
 * role's grant is widened. The caller panel's `canPin`.
 */
export function buyerWriteScopeFor(context: RequestContext): SQL {
  return withQueue(
    context,
    filterWhere(scopeFilterFor(context, 'update', 'Customer'), COLUMNS, 'Customer'),
  );
}

/**
 * The same, for a route that declares `update Customer` itself (`PUT /v1/customers/:id/
 * pinned-note`): the guard's filter for it, with the sales queue. Marks the scope applied.
 */
export function buyerWriteScopeSql(context: ActiveContext, request: object): SQL {
  return withQueue(context, scopeWhere(request, COLUMNS));
}

function withQueue(context: RequestContext, base: SQL): SQL {
  return context.roles.includes('sales') ? sql`(${base} or o.assigned_to is null)` : base;
}

const COLUMNS = {
  createdBy: sql`o.created_by`,
  assignedTo: sql`o.assigned_to`,
  branchId: sql`o.branch_id`,
};
