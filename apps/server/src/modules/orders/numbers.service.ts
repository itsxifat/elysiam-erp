import { Inject, Injectable } from '@nestjs/common';
import type {
  CustomerMergeInput,
  CustomerPhoneAddInput,
  CustomerPhoneRetireInput,
  CustomerPhoneUpdateInput,
  CustomerPhoneView,
  OrderBuyerChangeInput,
} from '@elysium/contracts/customers';
import { withOrg, type Tx } from '@elysium/db';
import {
  checkPhoneNote,
  isSupervisor,
  mergeNotes,
  mergeNumbersPlan,
  moveToRank,
  negateStats,
  normalizeBdPhone,
  orderStatsContribution,
  retirePlan,
  type OrderStatus,
} from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { CustomersService } from './customers.service.js';
import { addNumber, phoneViews } from './numbers.helpers.js';
import * as numbers from './numbers.repository.js';
import * as repo from './orders.repository.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import { orderScopeSql } from './orders.scope.js';
import { PROMO_PORT, type PromoPort } from './ports/promo.port.js';
import { deliveredNetItems } from './revenue.js';

/**
 * A buyer's numbers, merging two records of one person, and an order's buyer (M48, D-870 to
 * D-889).
 *
 * Who may change a buyer's numbers is who may update that buyer today (`update Customer` and the
 * buyer's reach, `CustomersService.assertReachable`): no role gains a grant (D-886). Merging two
 * buyers and changing an order's buyer are a supervisor's (org_admin, branch_manager, a super
 * admin), within their own reach. Every write is audited; a number appears in an audit row only
 * under a field named `phone` (the redactor masks it) and a note only by its length
 * (invariant 10).
 */
@Injectable()
export class CustomerNumbersService {
  constructor(
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    @Inject(IAM_API) private readonly iam: IamApi,
    @Inject(PROMO_PORT) private readonly promo: PromoPort,
  ) {}

  /** A person's numbers as the Numbers card shows them: in use by rank, then retired. */
  async viewsOf(tx: Tx, orgId: string, customerId: string): Promise<CustomerPhoneView[]> {
    return phoneViews(tx, this.iam, orgId, customerId);
  }

  async add(
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    input: CustomerPhoneAddInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.requirePerson(tx, context, request, customerId);
        const phone = normalizeBdPhone(input.phone);
        const active = await numbers.activePhonesOf(tx, context.orgId, customerId);
        if (active.some((row) => row.phone_e164 === phone)) {
          throw new OrdersError('CUSTOMER_PHONE_INVALID', 'This person already has that number.');
        }
        const added = await addNumber(tx, {
          orgId: context.orgId,
          customerId,
          phoneE164: phone,
          kind: input.kind ?? 'mobile',
          relation: input.relation ?? 'own',
          note: input.note,
          source: 'staff',
          addedByUserId: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'customer.phone_added',
          entityType: 'customer',
          entityId: customerId,
          after: {
            phoneId: added.id,
            phone,
            kind: input.kind ?? 'mobile',
            relation: input.relation ?? 'own',
            noteLength: input.note.trim().length,
          },
          request,
        });
        return { phones: await this.viewsOf(tx, context.orgId, customerId) };
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    phoneId: string,
    input: CustomerPhoneUpdateInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.requirePerson(tx, context, request, customerId);
        const active = await numbers.activePhonesOf(tx, context.orgId, customerId, {
          forUpdate: true,
        });
        const phone = active.find((row) => row.id === phoneId);
        if (phone === undefined) {
          throw new OrdersError(
            'CUSTOMER_PHONE_NOT_FOUND',
            'This person has no such number in use.',
          );
        }
        if (input.note !== undefined) {
          const note = checkPhoneNote(input.note, 'staff');
          if (!note.ok) {
            throw new OrdersError(
              'CUSTOMER_PHONE_INVALID',
              'A number’s note is 1 to 500 characters.',
            );
          }
        }
        await numbers.updatePhoneDetails(tx, context.orgId, phoneId, {
          kind: input.kind,
          relation: input.relation,
          note: input.note?.trim(),
        });
        if (input.rank !== undefined && input.rank !== phone.rank) {
          const order = moveToRank(
            active.map((row) => row.id),
            phoneId,
            input.rank,
          );
          if (order !== null) {
            await numbers.renumber(tx, context.orgId, customerId, order);
            await numbers.syncPrimaryCopy(tx, context.orgId, customerId);
          }
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: input.rank === 1 ? 'customer.phone_made_primary' : 'customer.phone_updated',
          entityType: 'customer',
          entityId: customerId,
          before: {
            phoneId,
            phone: phone.phone_e164,
            rank: phone.rank,
            kind: phone.kind,
            relation: phone.relation,
            noteLength: phone.note?.length ?? 0,
          },
          after: {
            phoneId,
            rank: input.rank ?? phone.rank,
            kind: input.kind ?? phone.kind,
            relation: input.relation ?? phone.relation,
            noteLength: input.note?.trim().length ?? phone.note?.length ?? 0,
          },
          request,
        });
        return { phones: await this.viewsOf(tx, context.orgId, customerId) };
      }),
    );
  }

  async retire(
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    phoneId: string,
    input: CustomerPhoneRetireInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.requirePerson(tx, context, request, customerId);
        const active = await numbers.activePhonesOf(tx, context.orgId, customerId, {
          forUpdate: true,
        });
        const plan = retirePlan(
          active.map((row) => row.id),
          phoneId,
        );
        if (!plan.ok) {
          throw plan.reason === 'not_active'
            ? new OrdersError('CUSTOMER_PHONE_NOT_FOUND', 'This person has no such number in use.')
            : new OrdersError(
                'CUSTOMER_PHONE_INVALID',
                'This is the person’s last number: add the new one first, then retire this.',
              );
        }
        const phone = active.find((row) => row.id === phoneId);
        await numbers.retirePhone(tx, context.orgId, phoneId, {
          byUserId: context.userId,
          reason: input.reason,
          note: input.note ?? null,
        });
        await numbers.renumber(tx, context.orgId, customerId, plan.remaining);
        await numbers.syncPrimaryCopy(tx, context.orgId, customerId);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'customer.phone_retired',
          entityType: 'customer',
          entityId: customerId,
          before: { phoneId, phone: phone?.phone_e164 ?? null, rank: phone?.rank ?? null },
          after: { phoneId, reason: input.reason, noteLength: input.note?.length ?? 0 },
          request,
        });
        return { phones: await this.viewsOf(tx, context.orgId, customerId) };
      }),
    );
  }

  /**
   * Merge `otherCustomerId` into `keptId` (D-884, D-885): the same person entered twice. The kept
   * record takes the other's numbers (one both had is retired on the merged side), addresses,
   * orders, counters, notes, tags, the details it lacks and its pinned note when it has none. The
   * other record stays, marked `merged_into`, for whatever still names it; the modules that store
   * a buyer move their rows on `customer.merged` (calls, inbox contacts, website accounts) or here,
   * through promo's port, for personal codes.
   */
  async merge(
    context: ActiveContext,
    request: AuditableRequest,
    keptId: string,
    input: CustomerMergeInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        this.assertSupervisor(context);
        if (input.otherCustomerId === keptId) {
          throw new OrdersError('CUSTOMER_MERGE_INVALID', 'A record cannot be merged into itself.');
        }
        await this.requirePerson(tx, context, request, keptId);
        await this.customers.assertReachable(tx, context, request, input.otherCustomerId);
        const locked = await numbers.lockForMerge(tx, context.orgId, [
          keptId,
          input.otherCustomerId,
        ]);
        const kept = locked.find((row) => row.id === keptId);
        const other = locked.find((row) => row.id === input.otherCustomerId);
        if (kept === undefined || other === undefined) {
          throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');
        }
        if (kept.merged_into_customer_id !== null || other.merged_into_customer_id !== null) {
          throw new OrdersError(
            'CUSTOMER_MERGE_INVALID',
            'One of these records was already merged into another.',
          );
        }

        const [keptPhones, otherPhones] = await Promise.all([
          numbers.activePhonesOf(tx, context.orgId, keptId, { forUpdate: true }),
          numbers.activePhonesOf(tx, context.orgId, other.id, { forUpdate: true }),
        ]);
        const plan = mergeNumbersPlan(
          keptPhones.map((row) => ({ id: row.id, phoneE164: row.phone_e164, rank: row.rank })),
          otherPhones.map((row) => ({ id: row.id, phoneE164: row.phone_e164, rank: row.rank })),
        );
        for (const id of plan.retire) {
          await numbers.retirePhone(tx, context.orgId, id, {
            byUserId: context.userId,
            reason: 'other',
            note: 'Merged: the kept record already has this number.',
          });
        }
        await numbers.movePhones(tx, context.orgId, {
          fromId: other.id,
          toId: keptId,
          ranks: plan.ranks,
        });
        const moved = await numbers.repointSales(tx, context.orgId, other.id, keptId);
        const tags = [...new Set([...tagsOf(kept.tags), ...tagsOf(other.tags)])].slice(0, 20);
        await numbers.absorbCustomer(tx, context.orgId, {
          keptId,
          mergedId: other.id,
          notes: mergeNotes(kept.notes, other.notes),
          tags,
          takePinned: kept.pinned_note === null && other.pinned_note !== null,
        });
        await numbers.markMerged(tx, context.orgId, {
          mergedId: other.id,
          keptId,
          byUserId: context.userId,
        });
        await numbers.syncPrimaryCopy(tx, context.orgId, keptId);
        const codes = await this.promo.moveCustomerCodes(tx, context.orgId, other.id, keptId);
        await emit(
          tx,
          'customer.merged',
          { keptId, mergedId: other.id, at: new Date().toISOString() },
          { orgId: context.orgId },
        );
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'customer.merged',
          entityType: 'customer',
          entityId: keptId,
          before: { mergedId: other.id, mergedName: other.name },
          after: {
            keptId,
            orders: moved.orders,
            addresses: moved.addresses,
            numbersMoved: plan.ranks.length - keptPhones.length,
            numbersRetired: plan.retire.length,
            personalCodes: codes,
            reasonLength: input.reason.length,
          },
          request,
        });
        return { keptId, mergedId: other.id, ordersMoved: moved.orders };
      }),
    );
  }

  /**
   * Put an order on the right buyer (D-882): a supervisor, within their reach of both the order and
   * the new buyer. The order's counts leave the old buyer and join the new one through the stats
   * path the transitions use (`applyStats`), and the old buyer's first and last order are read
   * again from the orders they still have. Naming the order's own buyer confirms them: the "check
   * the buyer" flag clears and nothing else moves.
   */
  async changeBuyer(
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
    input: OrderBuyerChangeInput,
  ) {
    const scope = orderScopeSql(context, request);
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        this.assertSupervisor(context);
        const locked = await repo.lockOrderInScope(tx, context.orgId, orderId, scope);
        if (locked === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        const order = await numbers.lockOrderBuyer(tx, context.orgId, orderId);
        if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        const target = await this.customers.require(tx, context.orgId, input.customerId);
        await this.customers.assertReachable(tx, context, request, target.id);
        if (target.merged_into_customer_id !== null) {
          throw new OrdersError(
            'CUSTOMER_MERGE_INVALID',
            'That record was merged into another; choose the one it was merged into.',
          );
        }

        if (target.id === order.customer_id) {
          await numbers.clearBuyerCheck(tx, context.orgId, orderId);
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'update',
            action: 'order.buyer_confirmed',
            entityType: 'order',
            entityId: orderId,
            before: { buyerCheck: order.buyer_check },
            after: { buyerCheck: null, reasonLength: input.reason.length },
            request,
          });
          return { orderId, customerId: target.id, changed: false };
        }

        const [reached, lines] = await Promise.all([
          numbers.statusesReached(tx, context.orgId, orderId),
          repo.orderLines(tx, context.orgId, orderId),
        ]);
        const contribution = orderStatsContribution({
          reached: new Set(reached as OrderStatus[]),
          deliveredNetPoisha: BigInt(deliveredNetItems(locked, lines)),
        });
        await numbers.setOrderBuyer(tx, context.orgId, orderId, target.id);
        await this.customers.applyStats(
          tx,
          context.orgId,
          order.customer_id,
          negateStats(contribution),
        );
        await numbers.refreshOrderDates(tx, context.orgId, order.customer_id);
        await this.customers.applyStats(tx, context.orgId, target.id, {
          ...contribution,
          orderedAt: order.created_at,
        });
        await emit(
          tx,
          'order.edited',
          { id: orderId, orderNo: order.order_no, at: new Date().toISOString() },
          { orgId: context.orgId },
        );
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.buyer_changed',
          entityType: 'order',
          entityId: orderId,
          before: { customerId: order.customer_id, buyerCheck: order.buyer_check },
          after: { customerId: target.id, buyerCheck: null, reasonLength: input.reason.length },
          request,
        });
        return { orderId, customerId: target.id, changed: true };
      }),
    );
  }

  /**
   * "The buyer is right" (D-876): whoever may work the order clears its shared-number check once
   * they have spoken to the buyer. Changing the buyer is still a supervisor's.
   */
  async buyerChecked(context: ActiveContext, request: AuditableRequest, orderId: string) {
    const scope = orderScopeSql(context, request);
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const locked = await repo.lockOrderInScope(tx, context.orgId, orderId, scope);
        if (locked === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        const order = await numbers.lockOrderBuyer(tx, context.orgId, orderId);
        await numbers.clearBuyerCheck(tx, context.orgId, orderId);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.buyer_confirmed',
          entityType: 'order',
          entityId: orderId,
          before: { buyerCheck: order?.buyer_check ?? null },
          after: { buyerCheck: null },
          request,
        });
        return { orderId, buyerCheck: null };
      }),
    );
  }

  private assertSupervisor(context: ActiveContext): void {
    if (!isSupervisor(context.roles, context.isSuperAdmin)) {
      throw new OrdersError(
        'CUSTOMER_SUPERVISOR_ONLY',
        'Only a supervisor changes an order’s buyer or merges two buyers.',
      );
    }
  }

  /** The buyer exists, is not a merged record, and is within the caller's reach. */
  private async requirePerson(
    tx: Tx,
    context: ActiveContext,
    request: object,
    customerId: string,
  ): Promise<void> {
    await this.customers.assertReachable(tx, context, request, customerId);
    const row = await this.customers.require(tx, context.orgId, customerId);
    if (row.merged_into_customer_id !== null) {
      throw new OrdersError(
        'CUSTOMER_MERGE_INVALID',
        'This record was merged into another; change that one instead.',
      );
    }
  }
}

function tagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
}
