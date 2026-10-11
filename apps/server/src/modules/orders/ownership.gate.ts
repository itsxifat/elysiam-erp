import { Inject, Injectable } from '@nestjs/common';
import { OWNER_ACK_HEADER } from '@elysium/contracts';
import type { Tx } from '@elysium/db';
import { ownershipVerdict, type OwnerGatedAct } from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { OrdersError } from './orders.errors.js';

/**
 * The one place an order's owner is defended (M41, D-710).
 *
 * Every desk write on an order (edit, confirm, hold, release hold, cancel, exchange, an advance
 * claim, a verification call, and each order of a bulk confirm) locks the order in the caller's
 * scope and then asks this gate. Nobody holds the order, or the caller does: on it goes. Somebody
 * else does: without `x-acknowledge-owner: 1` the request is refused with
 * `ORDER_HANDLED_BY_OTHER`, naming the owner and since when; with it the act goes through, an
 * `order.acted_over_owner` audit row is written in the act's own transaction, and the owner's
 * room is told through the outbox, so they hear of it the moment it commits and never of an act
 * that rolled back.
 *
 * The hub's fulfilment moves (pack, ship, deliver, returns, the packing station, the courier)
 * do not come here: from confirmation on, the order is the hub's work.
 */
export function ownerAcknowledged(request: object): boolean {
  const headers = (request as { headers?: Record<string, unknown> }).headers;
  const value = headers?.[OWNER_ACK_HEADER];
  return value === '1' || value === 'true';
}

/** "11 Oct, 10:42" in Asia/Dhaka (invariant 8), for a refusal a person reads. */
function dhakaTime(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

export interface GatedOrder {
  readonly id: string;
  readonly order_no: string;
  readonly assigned_to: string | null;
  readonly assigned_at?: Date | string | null;
}

@Injectable()
export class OwnershipGate {
  constructor(
    @Inject(IAM_API) private readonly iam: IamApi,
    private readonly audit: AuditService,
  ) {}

  async check(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    order: GatedOrder,
    act: OwnerGatedAct,
  ): Promise<void> {
    const verdict = ownershipVerdict({
      ownerId: order.assigned_to,
      callerId: context.userId,
      acknowledged: ownerAcknowledged(request),
    });
    if (verdict.kind === 'free') return;
    if (verdict.kind === 'refused') {
      const name = await this.nameOf(tx, context.orgId, verdict.ownerId);
      const since =
        order.assigned_at === null || order.assigned_at === undefined
          ? ''
          : ` since ${dhakaTime(new Date(order.assigned_at))}`;
      throw new OrdersError(
        'ORDER_HANDLED_BY_OTHER',
        `${name} is handling order ${order.order_no}${since}. Acknowledge that to act on it anyway; they will be told.`,
      );
    }
    await this.tellOwner(tx, context, request, order, verdict.ownerId, act);
  }

  /**
   * Record that somebody acted on another person's order, and tell that person.
   *
   * Also used by a supervisor's reassignment and release, which need no acknowledgement (it is
   * their job) but still owe the previous owner the news.
   */
  async tellOwner(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    order: GatedOrder,
    ownerId: string,
    act: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: 'order.acted_over_owner',
      entityType: 'order',
      entityId: order.id,
      before: { ownerId },
      after: { ownerId, act, acknowledged: ownerAcknowledged(request) },
      request,
    });
    await emit(
      tx,
      'order.acted_over_owner',
      { id: order.id, orderNo: order.order_no, ownerId, actorUserId: context.userId, act },
      { orgId: context.orgId },
    );
  }

  /** A colleague's name for a refusal, or a phrase that names nobody when they have left. */
  async nameOf(tx: Tx, orgId: string, userId: string): Promise<string> {
    const members = await this.iam.activeMembers(tx, orgId);
    return members.find((member) => member.userId === userId)?.name ?? 'A colleague';
  }
}
