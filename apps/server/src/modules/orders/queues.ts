import { sql, type SQL } from 'drizzle-orm';

import type { OrderQueue } from './orders.schemas.js';

/**
 * The desk's and the hub's queues as SQL (M11, M41: D-718, D-719).
 *
 * Each is a condition AND-ed with the caller's §6 scope by `listOrders`, so a queue only ever
 * narrows what the caller may see, and an order for the list. "Today" is Asia/Dhaka's calendar
 * day (invariant 8).
 *
 * The desk's open queues put due call-backs first: an order whose call-back time has come is the
 * next thing to do, ahead of every order waiting its turn.
 */
const DHAKA_TODAY = sql`(now() at time zone 'Asia/Dhaka')::date`;

/**
 * Due call-backs first (soonest due first), then the orders nobody asked to be called later
 * (oldest first), then the call-backs still to come (soonest first): an order the buyer asked to
 * be called about at six is not the next thing to do at four.
 */
const DUE_FIRST = sql`case when o.call_back_at is null then 1
    when o.call_back_at <= now() then 0 else 2 end,
  o.call_back_at asc nulls last, o.created_at asc`;

export function orderQueueSql(
  queue: OrderQueue | undefined,
  userId: string,
): { readonly where: SQL | undefined; readonly orderBy: SQL | undefined } {
  switch (queue) {
    case undefined:
      return { where: undefined, orderBy: undefined };
    // M11's two, unchanged: §6's queue at any status, and the caller's own.
    case 'unassigned':
      return { where: sql`o.assigned_to is null`, orderBy: undefined };
    case 'mine':
      return { where: sql`o.assigned_to = ${userId}`, orderBy: DUE_FIRST };
    // The sales desk.
    case 'new':
      return {
        where: sql`o.assigned_to is null and o.status = 'pending'`,
        orderBy: sql`o.created_at asc`,
      };
    case 'verifying':
      return {
        where: sql`o.status = 'pending' and o.assigned_to is not null and o.call_attempts > 0`,
        orderBy: DUE_FIRST,
      };
    case 'callbacks':
      return {
        where: sql`o.call_back_at is not null and o.call_back_at <= now()
          and o.status in ('pending', 'on_hold', 'confirmed')`,
        orderBy: sql`o.call_back_at asc`,
      };
    case 'confirmed_today':
      return {
        where: sql`o.confirmed_at is not null
          and (o.confirmed_at at time zone 'Asia/Dhaka')::date = ${DHAKA_TODAY}`,
        orderBy: sql`o.confirmed_at desc`,
      };
    // The fulfilment hub.
    case 'hub_print':
      return {
        where: sql`o.status = 'confirmed' and o.slip_printed_at is null`,
        orderBy: sql`o.confirmed_at asc nulls last`,
      };
    case 'hub_packing':
      return {
        where: sql`o.status = 'confirmed' and o.slip_printed_at is not null`,
        orderBy: sql`o.slip_printed_at asc`,
      };
    case 'hub_packed':
      return { where: sql`o.status = 'packed'`, orderBy: sql`o.packed_at asc nulls last` };
    case 'hub_handed':
      return {
        where: sql`o.handed_over_at is not null
          and (o.handed_over_at at time zone 'Asia/Dhaka')::date = ${DHAKA_TODAY}`,
        orderBy: sql`o.handed_over_at desc`,
      };
  }
}
