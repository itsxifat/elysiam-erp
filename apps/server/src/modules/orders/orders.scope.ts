import { scopeFilterFor } from '@elysium/contracts';
import type { RequestContext } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

import { filterWhere, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';

/**
 * §6's scope for orders, as SQL.
 *
 * The sales cell reads "own + unassigned queue", and the queue is added **only** for a
 * caller who actually holds `sales`. `reseller` holds the same `read Order|own` grant and
 * must not gain the queue with it: a reseller seeing every unassigned staff order is a
 * cross-tenant-shaped leak inside one org.
 *
 * Exported because the document endpoints answer the same question — an invoice is the
 * whole order in a form that can be forwarded — and two definitions of "may this caller
 * see this order" is one definition too many.
 */
export function orderScopeSql(context: ActiveContext, request: object): SQL {
  const base = scopeWhere(request, {
    createdBy: sql`o.created_by`,
    assignedTo: sql`o.assigned_to`,
    branchId: sql`o.branch_id`,
  });
  return context.roles.includes('sales') ? sql`(${base} or o.assigned_to is null)` : base;
}

/**
 * The same scope for a caller whose route declared another subject (M42, D-740): `read Order`
 * computed from the caller's own context, with the sales queue added the way `orderScopeSql`
 * adds it. The inbox's customer panel lists a buyer's orders through this, as the buyer profile
 * lists them through `orderScopeSql`.
 */
export function orderReadScopeFor(context: RequestContext): SQL {
  const base = filterWhere(scopeFilterFor(context, 'read', 'Order'), COLUMNS, 'Order');
  return context.roles.includes('sales') ? sql`(${base} or o.assigned_to is null)` : base;
}

const COLUMNS = {
  createdBy: sql`o.created_by`,
  assignedTo: sql`o.assigned_to`,
  branchId: sql`o.branch_id`,
};
