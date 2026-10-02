import { sql, type SQL } from 'drizzle-orm';

import { scopeWhere } from '../../platform/auth/scope.js';
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
