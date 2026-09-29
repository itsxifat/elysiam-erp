import { HttpException, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { normalizeBdPhone } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { scopeHasNoRowDimension, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CustomersService } from './customers.service.js';
import * as desk from './desk.repository.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import { OrdersService, orderScopeSql } from './orders.service.js';
import * as repo from './orders.repository.js';
import type { DuplicatesQuery } from './orders.schemas.js';

/**
 * What the order desk asks for that is not an order (M11; architecture §24).
 *
 * Each method here exists to save the agent a keystroke or a mistake, and each one is
 * bounded by the same §6 grant the order it serves is: the duplicate check by `read Order`,
 * the phone lookup by `read Customer`, bulk confirm by `update Order` and exactly the
 * per-order checks a single confirm makes. Nothing here moves an order except through
 * `OrdersService.confirm`, which is the domain machine's front door (invariant 7).
 */

export interface DuplicateView {
  /** Present only when the caller may open the order. */
  readonly id: string | null;
  readonly orderNo: string;
  readonly status: string;
  readonly createdAt: string;
  readonly visible: boolean;
  /** Which of the SKUs asked about this order also carries. */
  readonly skuIds: readonly string[];
}

export type BulkConfirmResult =
  | { readonly id: string; readonly ok: true; readonly orderNo: string; readonly status: string }
  | { readonly id: string; readonly ok: false; readonly code: string; readonly message: string };

/** The code and message a refusal carried, for a bulk result row. */
function refusalOf(error: HttpException): { code: string; message: string } {
  const body = error.getResponse();
  if (typeof body === 'object' && body !== null) {
    const record = body as { code?: unknown; message?: unknown; detail?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : 'CONFLICT',
      message:
        typeof record.message === 'string'
          ? record.message
          : typeof record.detail === 'string'
            ? record.detail
            : error.message,
    };
  }
  return { code: 'CONFLICT', message: typeof body === 'string' ? body : error.message };
}

@Injectable()
export class DeskService {
  constructor(
    private readonly orders: OrdersService,
    private readonly customers: CustomersService,
  ) {}

  /**
   * The duplicate warning: this number, these SKUs, the last 24 hours (M11 Build list).
   *
   * Brand-wide by design — see `recentDuplicates` — with the ids of orders outside the
   * caller's scope withheld. The warning is advice, not a lock: the desk shows it and the
   * agent decides, because a buyer ordering the same kurta for a sister is a real thing
   * and a refusal would send them to a competitor.
   */
  async duplicates(context: ActiveContext, request: object, query: DuplicatesQuery) {
    return mapOrderErrors(async () => {
      const phoneE164 = normalizeBdPhone(query.phone);
      // Computed (and so marked applied) before the read: it is the `visible` column, and
      // the backstop must see it applied whether or not any row comes back.
      const scope = orderScopeSql(context, request);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await desk.recentDuplicates(tx, context.orgId, {
          phoneE164,
          skuIds: query.skuIds,
          scope,
        });
        const items: DuplicateView[] = rows.map((row) => ({
          id: row.visible ? row.id : null,
          orderNo: row.order_no,
          status: row.status,
          createdAt: new Date(row.created_at).toISOString(),
          visible: row.visible,
          skuIds: row.sku_ids,
        }));
        return { items };
      });
    });
  }

  /**
   * Phone → buyer, their saved addresses and their last few orders, in one round trip.
   *
   * The desk's first question, asked while the agent is still reading the number off a
   * chat. A buyer outside the caller's §6 reach comes back as `null`, the same answer as a
   * number nobody has used — `assertReachable`'s rule (D-114) — so the lookup cannot be
   * used to learn which numbers another agent sells to. The order that follows still lands
   * on the right buyer: `create` finds them by phone either way.
   */
  async lookup(context: ActiveContext, request: object, phone: string) {
    return mapOrderErrors(async () => {
      const phoneE164 = normalizeBdPhone(phone);
      // Marked applied up front: an unknown number returns before any buyer is checked,
      // and the scope backstop must not read that as a handler that forgot to filter.
      scopeWhere(request, {
        createdBy: sql`o.created_by`,
        assignedTo: sql`o.assigned_to`,
        branchId: sql`o.branch_id`,
      });
      const recentScope = orderScopeSql(context, request);

      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.customerByPhone(tx, context.orgId, phoneE164);
        if (row === undefined) return { phone: phoneE164, customer: null };

        try {
          await this.customers.assertReachable(tx, context, request, row.id);
        } catch (error) {
          if (error instanceof OrdersError && error.code === 'CUSTOMER_NOT_FOUND') {
            return { phone: phoneE164, customer: null };
          }
          throw error;
        }

        const [addresses, recent] = await Promise.all([
          repo.listAddresses(tx, context.orgId, row.id),
          desk.recentOrdersFor(tx, context.orgId, row.id, recentScope),
        ]);
        return {
          phone: phoneE164,
          customer: {
            id: row.id,
            name: row.name,
            phone: row.phone_e164,
            stats: {
              orders: row.orders_total,
              delivered: row.delivered_count,
              returned: row.returned_count,
              cancelled: row.cancelled_count,
            },
            addresses: addresses.map((address) => ({
              id: address.id,
              districtId: address.district_id,
              thanaId: address.thana_id,
              area: address.area,
              addressLine: address.address_line,
              isDefault: address.is_default,
            })),
            recentOrders: recent.map((order) => ({
              id: order.id,
              orderNo: order.order_no,
              status: order.status,
              channel: order.channel,
              codAmountPoisha: String(order.cod_amount_poisha),
              createdAt: new Date(order.created_at).toISOString(),
            })),
          },
        };
      });
    });
  }

  /**
   * Every thana with its district and zone, for the desk's address autocomplete.
   *
   * Reference data plus this org's own zone mapping — no row of anybody's — and every role
   * holding `read Catalog` holds it at `org`, so there is nothing for the scope to narrow.
   */
  async areas(context: ActiveContext) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const [rows, zones] = await Promise.all([
          desk.areasWithZones(tx, context.orgId),
          repo.listZones(tx, context.orgId),
        ]);
        return {
          zones: zones
            .filter((zone) => zone.is_active)
            .map((zone) => ({
              id: zone.id,
              code: zone.code,
              nameEn: zone.name_en,
              nameBn: zone.name_bn,
              chargePoisha: String(zone.charge_poisha),
            })),
          areas: rows.map((row) => ({
            thanaId: row.thana_id,
            thanaEn: row.thana_en,
            thanaBn: row.thana_bn,
            districtId: row.district_id,
            districtEn: row.district_en,
            districtBn: row.district_bn,
            zoneId: row.zone_id,
          })),
        };
      }),
    );
  }

  /**
   * The people who act on orders, for the agent filter and the timeline's names.
   *
   * `read Order` is the declared ability, because the question is "whose orders may I
   * filter by", and a person is not an order row: `scopeHasNoRowDimension` says so, with the
   * reason, rather than pretending a list of colleagues has a `created_by`. A reseller holds
   * `read Order` too, at `own` — and a partner outside the company has no reason to be
   * handed the brand's staff list, so they get an empty one.
   */
  async agents(context: ActiveContext, request: object) {
    scopeHasNoRowDimension(
      request,
      'the brand’s order agents are people, not order rows: no created_by, no branch_id',
    );
    const staff = context.isSuperAdmin || context.roles.some((role) => role !== 'reseller');
    if (!staff) return { items: [] };

    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await desk.orderAgents(tx, context.orgId);
        return {
          items: rows.map((row) => ({ userId: row.user_id, name: row.name, roles: row.roles })),
        };
      }),
    );
  }

  /**
   * Confirm several orders, each on its own (M11 Build list: bulk confirm).
   *
   * One transaction per order, through exactly the path a single confirm takes — the scope
   * lock, the live fraud gate, the domain machine, the reservation. Never one transaction
   * for the batch: the orders are independent sales, and one scarce SKU or one blocked
   * buyer must not roll back the forty that could go. Each refusal is reported against its
   * own id with the code a single confirm would have answered.
   *
   * Sequential rather than parallel, and that is about stock, not speed: two orders in one
   * batch competing for the last unit must be decided in the order the agent selected them,
   * not in whichever order two connections happened to take the row lock.
   *
   * A refusal that is not an HTTP-shaped one — a genuine fault — stops the batch and
   * propagates. Reporting a 500 as one more failed row would bury a bug under forty
   * successes.
   */
  async bulkConfirm(
    context: ActiveContext,
    request: AuditableRequest,
    ids: readonly string[],
  ): Promise<{ results: BulkConfirmResult[]; confirmed: number }> {
    const results: BulkConfirmResult[] = [];
    for (const id of ids) {
      try {
        const confirmed = await this.orders.confirm(context, request, id, {});
        results.push({ id, ok: true, orderNo: confirmed.orderNo, status: confirmed.status });
      } catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
        results.push({ id, ok: false, ...refusalOf(error) });
      }
    }
    return { results, confirmed: results.filter((result) => result.ok).length };
  }
}
