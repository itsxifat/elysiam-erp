import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import {
  selectCourier,
  validateRuleSet,
  type CourierSelection,
  type CourierSelectionRule,
} from '@elysium/domain/courier';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { COURIER_ADAPTERS, type CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { adapterEnabled } from './courier.config.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import type { ReplaceSelectionRulesInput } from './courier.schemas.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';

/**
 * Zone → courier rules, and the recommendation for an order's courier (M15).
 *
 * `selectCourier` in the domain makes the decision; this service gives it the org's rules and
 * the one fact the domain cannot know — whether a courier can take a parcel *now*: an active
 * account, on an adapter this process has, switched on.
 *
 * The answer is for the **order**: the desk applies it to the order's courier, and `resolve`
 * is the method the orders module can call when it takes an order (INTEGRATION). Booking does
 * not consult it — it uses the order's courier and refuses any other, for the receivable
 * reason `BookingService.reserveConsignment` gives.
 */
@Injectable()
export class CourierSelectionService {
  constructor(
    @Inject(COURIER_ADAPTERS) private readonly adapters: CourierAdapterRegistry,
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    private readonly audit: AuditService,
  ) {}

  /** The org's rules, as the domain reads them. */
  private async rules(tx: Tx, orgId: string): Promise<CourierSelectionRule[]> {
    return (await repo.listSelectionRules(tx, orgId)).map((row) => ({
      id: row.id,
      priority: row.priority,
      deliveryZoneId: row.delivery_zone_id,
      minCodPoisha: row.min_cod_poisha === null ? null : poisha(BigInt(row.min_cod_poisha)),
      maxCodPoisha: row.max_cod_poisha === null ? null : poisha(BigInt(row.max_cod_poisha)),
      courierId: row.courier_id,
      isActive: row.is_active,
    }));
  }

  /** Couriers that can take a parcel now: an active account on an enabled adapter. */
  async bookableCourierIds(tx: Tx, orgId: string): Promise<Set<string>> {
    const bookable = new Set<string>();
    for (const account of await repo.activeAccountProviders(tx, orgId)) {
      const adapter = this.adapters.get(account.provider_code);
      if (adapter !== undefined && adapterEnabled(adapter)) bookable.add(account.courier_id);
    }
    return bookable;
  }

  /**
   * Decide the courier for one order, in the caller's transaction.
   *
   * Used by `BookingService.reserveConsignment`, which runs inside the transaction that moves
   * the order — so this reads and decides and never writes.
   */
  async resolve(
    tx: Tx,
    orgId: string,
    input: {
      requestedCourierId: string | null;
      orderCourierId: string | null;
      deliveryZoneId: string | null;
      codAmountPoisha: bigint;
    },
  ): Promise<CourierSelection> {
    const [rules, bookable] = await Promise.all([
      this.rules(tx, orgId),
      this.bookableCourierIds(tx, orgId),
    ]);
    return selectCourier(
      {
        requestedCourierId: input.requestedCourierId,
        orderCourierId: input.orderCourierId,
        deliveryZoneId: input.deliveryZoneId,
        codAmountPoisha: poisha(input.codAmountPoisha),
      },
      rules,
      (courierId) => bookable.has(courierId),
    );
  }

  /** What booking this order now would choose, and why — the desk's preview. */
  async preview(
    context: ActiveContext,
    request: object,
    input: { orderId: string; courierId?: string | undefined },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const order = await this.orders.summary(tx, context.orgId, input.orderId);
      if (order === undefined) {
        throw new CourierError('ORDER_NOT_FOUND', 'No such order in this organization.');
      }
      assertInScope(request, { branchId: order.branchId });
      const selection = await this.resolve(tx, context.orgId, {
        requestedCourierId: input.courierId ?? null,
        orderCourierId: order.courierId,
        deliveryZoneId: order.deliveryZoneId,
        codAmountPoisha: BigInt(order.codAmountPoisha),
      });
      return {
        orderId: input.orderId,
        deliveryZoneId: order.deliveryZoneId,
        courierId: selection.courierId,
        source: selection.source,
        ruleId: selection.ruleId,
        skippedRuleIds: selection.skippedRuleIds,
        /** What the order names now. Booking uses this one, and only this one (M15). */
        orderCourierId: order.courierId,
        /**
         * True when the rules recommend a courier the order does not name. The desk then
         * changes the order's courier *before* booking — booking refuses a parcel whose
         * courier is not the order's, because the receivable is booked against the order's.
         */
        differsFromOrder: selection.courierId !== null && selection.courierId !== order.courierId,
      };
    });
  }

  async list(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listSelectionRules(tx, context.orgId)).map((row) => view(row)),
    }));
  }

  /**
   * Replace the rule set.
   *
   * Validated in the domain first — a reversed COD band or two identical rules pointing at
   * different couriers is refused with the row it is on, before anything is written — and
   * the audit row carries the whole set before and after, which is what makes a delete-and-
   * insert replacement reviewable.
   */
  async replace(
    context: ActiveContext,
    request: AuditableRequest,
    input: ReplaceSelectionRulesInput,
  ) {
    const rules = input.rules.map((rule) => ({
      priority: rule.priority,
      deliveryZoneId: rule.deliveryZoneId ?? null,
      minCodPoisha: rule.minCodPoisha === undefined ? null : poisha(BigInt(rule.minCodPoisha)),
      maxCodPoisha: rule.maxCodPoisha === undefined ? null : poisha(BigInt(rule.maxCodPoisha)),
      courierId: rule.courierId,
      isActive: rule.isActive,
      note: rule.note ?? null,
    }));

    const problems = validateRuleSet(rules);
    const first = problems[0];
    if (first !== undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `Rule ${String(first.index + 1)}: ${first.message}`,
      );
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.listSelectionRules(tx, context.orgId);
      await repo.replaceSelectionRules(tx, context.orgId, rules, context.userId);
      const after = await repo.listSelectionRules(tx, context.orgId);

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'courier.selection_rules.replaced',
        entityType: 'CourierSettlement',
        entityId: context.orgId,
        before: { rules: before.map((row) => view(row)) },
        after: { rules: after.map((row) => view(row)) },
        requestId: context.requestId,
        request,
      });

      return { items: after.map((row) => view(row)) };
    });
  }
}

function view(row: repo.SelectionRuleRow) {
  return {
    id: row.id,
    priority: row.priority,
    deliveryZoneId: row.delivery_zone_id,
    minCodPoisha: row.min_cod_poisha,
    maxCodPoisha: row.max_cod_poisha,
    courierId: row.courier_id,
    isActive: row.is_active,
    note: row.note,
    updatedAt: row.updated_at,
  };
}
