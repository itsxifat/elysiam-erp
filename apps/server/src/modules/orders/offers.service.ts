import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WorkflowSettingsInput } from '@elysium/contracts';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import {
  MAX_OPEN_DEFAULT,
  OFFER_SECONDS_DEFAULT,
  pickAssignee,
  presenceState,
  type AssignmentCandidate,
} from '@elysium/domain/assignment';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { TEAM_API, type TeamApi } from '../team/team.api.js';
import { OFFER_QUEUES } from './offers.queues.js';
import * as offers from './offers.repository.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import * as repo from './orders.repository.js';

/**
 * Auto-assign (M41, D-715 to D-717): a new order is offered to one person at a time, who has the
 * brand's countdown to accept or decline it, like a ride offer.
 *
 * ## Who is offered what
 *
 * `pickAssignee` in `@elysium/domain/assignment` decides, from facts this service gathers in the
 * dispatching transaction: each person's presence (derived at the database's `now()`), the work
 * types on their desk profile, their open orders (pending or on hold) against the brand's cap,
 * when they were last offered something, whether they already hold a live offer, and whether
 * they declined or let lapse an offer of this very order. Nobody eligible: the order waits in
 * New, where anyone can take it, and the next sweep, presence change or release tries again.
 *
 * Only people who would see the order once it is theirs are offered it: holders of `sales`
 * (their own orders), `org_admin` or `warehouse` (the whole brand). A branch manager's scope is
 * their branches, and the desk's orders belong to none, so they take orders by hand (D-716).
 *
 * ## Exactly once, whatever races
 *
 * The order is locked while it is dispatched, so two dispatchers of one order run one after the
 * other and the second sees the first's offer. Two dispatchers of different orders can pick the
 * same person; the partial unique index on live offers per person turns the second insert into
 * nothing, and the dispatcher picks again without that person. Accepting is one statement
 * (`acceptOffer`), so a manual claim and an accept cannot both win.
 *
 * ## No external call
 *
 * Nothing here leaves the database (invariant 6): the offer is a row, the person's card is an
 * outbox event, and the deadline is a pg-boss job enqueued in the same transaction.
 */

/** Who the dispatcher acts as, in the audit log and the outbox (`app.user_id`). */
export const OFFER_ACTOR = 'system:auto-assign';

/** Roles that see an order once it is theirs, whatever its branch (D-716). */
const OFFERABLE_ROLES: readonly string[] = ['sales', 'org_admin', 'warehouse'];

/** The roles the team board lists, whatever their desk profile says. */
const BOARD_ROLES: readonly string[] = ['sales', 'warehouse', 'branch_manager'];

/** How many people a dispatcher tries before it gives up on an order for now. */
const PICK_ATTEMPTS = 5;

/** How many waiting orders one sweep or one presence change dispatches. */
const SWEEP_BATCH = 25;

export interface WorkflowSettings {
  readonly autoAssign: boolean;
  readonly offerSeconds: number;
  readonly maxOpen: number;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

@Injectable()
export class OffersService {
  private readonly logger = new Logger('OffersService');

  constructor(
    @Inject(TEAM_API) private readonly team: TeamApi,
    private readonly audit: AuditService,
  ) {}

  // --- settings ---------------------------------------------------------------------

  async settingsIn(tx: Tx, orgId: string): Promise<WorkflowSettings> {
    const row = await offers.settingsOf(tx, orgId);
    return {
      autoAssign: row?.auto_assign ?? false,
      offerSeconds: row?.offer_seconds ?? OFFER_SECONDS_DEFAULT,
      maxOpen: row?.max_open ?? MAX_OPEN_DEFAULT,
    };
  }

  async getSettings(context: ActiveContext, request: object) {
    scopeHasNoRowDimension(request, 'the order workflow is one row of brand settings');
    return withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      this.settingsIn(tx, context.orgId),
    );
  }

  async saveSettings(
    context: ActiveContext,
    request: AuditableRequest,
    input: WorkflowSettingsInput,
  ) {
    scopeHasNoRowDimension(request, 'the order workflow is one row of brand settings');
    return mapOrderErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await this.settingsIn(tx, context.orgId);
        await offers.saveSettings(tx, {
          orgId: context.orgId,
          ...input,
          updatedBy: context.userId,
        });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.workflow_settings_saved',
          entityType: 'workflow_settings',
          entityId: context.orgId,
          before: { ...before },
          after: { ...input },
          request,
        });
        if (input.autoAssign && !before.autoAssign) {
          // Switched on: the orders already waiting are offered now, not at the next sweep.
          await this.queueDispatch(tx, context.orgId, null);
        }
        if (!input.autoAssign && before.autoAssign) {
          // Switched off: nobody keeps a card for an order that will no longer be assigned.
          // In order id order, so two of these never lock the same orders crosswise.
          const live = [...(await offers.liveOffers(tx, context.orgId))].sort((a, b) =>
            a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : 0,
          );
          for (const offer of live) {
            await repo.orderForUpdate(tx, context.orgId, offer.order_id);
            await this.closeAndTell(tx, context.orgId, offer.id, 'withdrawn');
          }
        }
        return this.settingsIn(tx, context.orgId);
      }),
    );
  }

  // --- the person's side ---------------------------------------------------------------

  /** The caller's live offers, with what the card shows: number, area, pieces, cash to collect. */
  async mine(context: ActiveContext, request: object) {
    scopeHasNoRowDimension(
      request,
      'an offer is addressed to the caller by id; the order it names is shown only to them',
    );
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await offers.offerCardsFor(tx, context.orgId, context.userId);
      const items = [];
      for (const row of rows) {
        const area = await repo.areaNames(tx, row.ship_district_id, row.ship_thana_id);
        items.push({
          id: row.id,
          orderId: row.order_id,
          orderNo: row.order_no,
          area: {
            thana: area?.thana_en ?? null,
            district: area?.district_en ?? null,
            detail: row.ship_area,
          },
          itemCount: row.item_count,
          codAmountPoisha: row.cod_amount_poisha,
          offeredAt: iso(row.offered_at),
          expiresAt: iso(row.expires_at),
        });
      }
      return { items };
    });
  }

  /** Accept: the order is the caller's if the offer is still live and nobody took the order. */
  async accept(context: ActiveContext, request: AuditableRequest, offerId: string) {
    scopeHasNoRowDimension(request, 'an offer is the caller’s own by its user id');
    return mapOrderErrors(() => this.acceptIn(context, request, offerId));
  }

  private async acceptIn(context: ActiveContext, request: AuditableRequest, offerId: string) {
    const outcome = await withOrg(
      { orgId: context.orgId, userId: context.userId },
      async (tx): Promise<{ orderId: string; orderNo: string } | { gone: string }> => {
        const offer = await offers.offerById(tx, context.orgId, offerId);
        if (offer?.user_id !== context.userId) {
          return { gone: 'No such offer.' };
        }
        // The order first, then its offer: the order a take, a transition and a dispatch lock
        // them in, so an accept racing any of them waits rather than deadlocks.
        await repo.orderForUpdate(tx, context.orgId, offer.order_id);
        const taken = await offers.acceptOffer(tx, {
          orgId: context.orgId,
          offerId,
          userId: context.userId,
        });
        if (taken === undefined) {
          // Lapsed, answered, or the order went another way. A live offer for an order that
          // is no longer free is withdrawn here, so the person's next offer is not held up.
          const order = await repo.orderById(tx, context.orgId, offer.order_id);
          if (
            offer.status === 'offered' &&
            (order?.status !== 'pending' || order.assigned_to !== null)
          ) {
            await this.closeAndTell(tx, context.orgId, offerId, 'withdrawn');
          }
          return { gone: 'This offer has ended: it ran out, or the order was taken.' };
        }
        const order = await repo.orderById(tx, context.orgId, taken.order_id);
        const orderNo = order?.order_no ?? '';
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.offer_accepted',
          entityType: 'order',
          entityId: taken.order_id,
          before: { assignedTo: null, offerId },
          after: { assignedTo: context.userId, offerId },
          request,
        });
        await emit(
          tx,
          'order.offer_closed',
          { offerId, orderId: taken.order_id, userId: context.userId, outcome: 'accepted' },
          { orgId: context.orgId },
        );
        await emit(
          tx,
          'order.claimed',
          { id: taken.order_id, orderNo, assignedTo: context.userId },
          { orgId: context.orgId },
        );
        return { orderId: taken.order_id, orderNo };
      },
    );
    if ('gone' in outcome) throw OfferGone(outcome.gone);
    return { accepted: true, ...outcome };
  }

  /** Decline: the order goes on to the next person. */
  async decline(context: ActiveContext, request: AuditableRequest, offerId: string) {
    scopeHasNoRowDimension(request, 'an offer is the caller’s own by its user id');
    return mapOrderErrors(() => this.declineIn(context, request, offerId));
  }

  private async declineIn(context: ActiveContext, request: AuditableRequest, offerId: string) {
    const closed = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const offer = await offers.closeOffer(tx, {
        orgId: context.orgId,
        offerId,
        status: 'declined',
        userId: context.userId,
      });
      if (offer === undefined) return undefined;
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'order.offer_declined',
        entityType: 'order',
        entityId: offer.order_id,
        before: { offerId, status: 'offered' },
        after: { offerId, status: 'declined' },
        request,
      });
      await emit(
        tx,
        'order.offer_closed',
        { offerId, orderId: offer.order_id, userId: context.userId, outcome: 'declined' },
        { orgId: context.orgId },
      );
      await this.queueDispatch(tx, context.orgId, offer.order_id);
      return offer;
    });
    if (closed === undefined) throw OfferGone('This offer has already ended.');
    return { declined: true, orderId: closed.order_id };
  }

  // --- the team board (D-720) -----------------------------------------------------------

  /**
   * The supervisors' board: each person who works orders, how present they are, their open
   * orders, their confirmations today and the offer they are looking at, beside the brand's
   * settings and how many new orders wait. People and counts, never an order's contents; the
   * board's reassign goes through the order's own route and its scope.
   */
  async board(context: ActiveContext, request: object) {
    scopeHasNoRowDimension(request, 'the team board is people and counts, not order rows');
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const now = await transactionNow(tx);
      const [settings, members, loads, confirmed, live, waiting] = await Promise.all([
        this.settingsIn(tx, context.orgId),
        this.team.members(tx, context.orgId),
        offers.openLoads(tx, context.orgId),
        offers.confirmedToday(tx, context.orgId),
        offers.liveOffers(tx, context.orgId),
        offers.waitingCount(tx, context.orgId),
      ]);
      const offerOf = new Map(live.map((row) => [row.user_id, row]));
      const people = members
        .filter(
          (member) =>
            member.roles.some((role) => BOARD_ROLES.includes(role)) ||
            member.workTypes.length > 0 ||
            loads.has(member.userId),
        )
        .map((member) => {
          const offer = offerOf.get(member.userId);
          return {
            userId: member.userId,
            name: member.name,
            roles: member.roles,
            workTypes: member.workTypes,
            hubLocationId: member.hubLocationId,
            presence: {
              ...presenceState(member.presence, now),
              lastSeenAt: iso(member.presence.lastSeenAt),
            },
            openOrders: loads.get(member.userId) ?? 0,
            confirmedToday: confirmed.get(member.userId) ?? 0,
            offer:
              offer === undefined
                ? null
                : { id: offer.id, orderId: offer.order_id, expiresAt: iso(offer.expires_at) },
          };
        });
      return { settings, waiting, people, at: now.toISOString() };
    });
  }

  // --- for the orders module's own transactions ------------------------------------------

  /** The order was taken another way or left New: its live offer ends. */
  async withdrawFor(tx: Tx, orgId: string, orderId: string): Promise<void> {
    for (const offer of await offers.withdrawOffersOf(tx, orgId, orderId)) {
      await emit(
        tx,
        'order.offer_closed',
        { offerId: offer.id, orderId, userId: offer.user_id, outcome: 'withdrawn' },
        { orgId },
      );
    }
  }

  /**
   * Ask the worker to offer this order (or, with null, every waiting order) after commit. Only
   * while the brand auto-assigns: with it off nothing is offered, so nothing is queued.
   */
  async queueDispatch(tx: Tx, orgId: string, orderId: string | null): Promise<void> {
    if (!(await this.settingsIn(tx, orgId)).autoAssign) return;
    await enqueue(tx, OFFER_QUEUES.dispatch.name, { orderId }, { orgId, ref: orderId });
  }

  // --- the worker -----------------------------------------------------------------------

  /** Offer one order, or with null every waiting order, in the brand. */
  async dispatch(orgId: string, orderId: string | null): Promise<number> {
    if (orderId !== null) {
      return withOrg({ orgId, userId: OFFER_ACTOR }, async (tx) =>
        (await this.dispatchIn(tx, orgId, orderId)) ? 1 : 0,
      );
    }
    const waiting = await withOrg({ orgId, userId: OFFER_ACTOR }, async (tx) =>
      (await this.settingsIn(tx, orgId)).autoAssign
        ? offers.waitingOrders(tx, orgId, SWEEP_BATCH)
        : [],
    );
    let offered = 0;
    // One transaction per order, so one order's trouble never holds back the rest.
    for (const id of waiting) {
      const done = await withOrg({ orgId, userId: OFFER_ACTOR }, (tx) =>
        this.dispatchIn(tx, orgId, id),
      );
      if (done) offered += 1;
    }
    return offered;
  }

  /** The deadline of one offer: expired if still unanswered, and the order moves on. */
  async expire(orgId: string, offerId: string): Promise<boolean> {
    return withOrg({ orgId, userId: OFFER_ACTOR }, async (tx) => {
      const offer = await offers.offerById(tx, orgId, offerId);
      if (offer?.status !== 'offered') return false;
      // The order first, then the offer, the same order a take locks them in.
      await repo.orderForUpdate(tx, orgId, offer.order_id);
      const closed = await this.closeAndTell(tx, orgId, offerId, 'expired', true);
      if (closed === undefined) return false;
      /*
       * The next person is offered it by a job after this commits, not here: a dispatch in
       * this transaction could pick someone whose own lapsed offer another expiry is closing
       * at this moment, and the two would wait on each other (the ledger audit of M41).
       */
      await this.queueDispatch(tx, orgId, closed.order_id);
      return true;
    });
  }

  /** Every minute: lapse what ran out, then offer what waits, in every brand that auto-assigns. */
  async sweep(): Promise<{
    readonly brands: number;
    readonly expired: number;
    readonly offered: number;
  }> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.organizations where is_active order by slug
      `);
      return [...rows].map((row) => row.id);
    });
    let expired = 0;
    let offered = 0;
    let brands = 0;
    for (const orgId of orgIds) {
      try {
        const overdue = await withOrg({ orgId, userId: OFFER_ACTOR }, async (tx) => ({
          rows: await offers.overdueOffers(tx, orgId, 200),
          on: await offers.autoAssignOn(tx, orgId),
        }));
        // One lapse per transaction, each locking its own order only: never two orders in
        // one transaction, so the sweep cannot wait on a dispatcher that waits on it.
        for (const row of overdue.rows) {
          if (await this.expire(orgId, row.id)) expired += 1;
        }
        if (!overdue.on) continue;
        brands += 1;
        offered += await this.dispatch(orgId, null);
      } catch (error) {
        // One brand's trouble never holds the others; its next minute tries again.
        this.logger.error({ err: String(error), orgId }, 'auto-assign sweep failed for a brand');
      }
    }
    return { brands, expired, offered };
  }

  /**
   * Offer one order to the right person, in the caller's transaction. True when an offer was
   * made. Locks the order first, so two dispatchers of the same order are one after the other.
   */
  async dispatchIn(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    const settings = await this.settingsIn(tx, orgId);
    if (!settings.autoAssign) return false;
    const order = await repo.orderForUpdate(tx, orgId, orderId);
    if (order?.status !== 'pending' || order.assigned_to !== null) return false;
    if ((await offers.liveOfferFor(tx, orgId, orderId)) !== undefined) return false;
    // Anything past its deadline for this order is lapsed first, so it counts as declined.
    for (const row of await offers.overdueOffersOf(tx, orgId, orderId)) {
      await this.closeAndTell(tx, orgId, row.id, 'expired', true);
    }

    const now = await transactionNow(tx);
    const [members, loads, lastOffered, live, declined] = await Promise.all([
      this.team.members(tx, orgId),
      offers.openLoads(tx, orgId),
      offers.lastOfferedAt(tx, orgId),
      // Every unanswered offer counts, lapsed or not: a person whose lapsed offer another
      // transaction is closing right now is never picked, so no insert waits on that close.
      offers.offeredUsers(tx, orgId),
      offers.declinedBy(tx, orgId, orderId),
    ]);
    const busy = live;
    const excluded = new Set(declined);
    const candidates: AssignmentCandidate[] = members
      .filter((member) => member.roles.some((role) => OFFERABLE_ROLES.includes(role)))
      .map((member) => {
        const reading = presenceState(member.presence, now);
        return {
          userId: member.userId,
          presence: reading.state,
          paused: reading.paused,
          workTypes: member.workTypes,
          openLoad: loads.get(member.userId) ?? 0,
          maxLoad: settings.maxOpen,
          lastOfferedAt: lastOffered.get(member.userId) ?? null,
          hasLiveOffer: busy.has(member.userId),
        };
      });

    for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
      const picked = pickAssignee({ kind: 'order', candidates, declinedBy: excluded });
      if (picked === null) return false;
      const offer = await offers.insertOffer(tx, {
        orgId,
        orderId,
        userId: picked,
        seconds: settings.offerSeconds,
      });
      if (offer === undefined) {
        // Somebody else's dispatcher offered this person something a moment ago.
        excluded.add(picked);
        continue;
      }
      await this.audit.record(tx, {
        orgId,
        actorUserId: OFFER_ACTOR,
        operation: 'create',
        action: 'order.offered',
        entityType: 'order',
        entityId: orderId,
        after: { offerId: offer.id, userId: picked, expiresAt: iso(offer.expires_at) },
      });
      await emit(
        tx,
        'order.offered',
        {
          offerId: offer.id,
          orderId,
          orderNo: order.order_no,
          userId: picked,
          expiresAt: iso(offer.expires_at) ?? '',
        },
        { orgId },
      );
      // The deadline, as a job that starts once it has passed (D-717).
      await enqueue(
        tx,
        OFFER_QUEUES.expire.name,
        { offerId: offer.id },
        { orgId, ref: offer.id, startAfter: settings.offerSeconds + 1 },
      );
      return true;
    }
    return false;
  }

  private async closeAndTell(
    tx: Tx,
    orgId: string,
    offerId: string,
    status: 'declined' | 'expired' | 'withdrawn',
    onlyIfOverdue = false,
  ): Promise<offers.OfferRow | undefined> {
    const closed = await offers.closeOffer(tx, { orgId, offerId, status, onlyIfOverdue });
    if (closed === undefined) return undefined;
    if (status === 'expired') {
      await this.audit.record(tx, {
        orgId,
        actorUserId: OFFER_ACTOR,
        operation: 'update',
        action: 'order.offer_expired',
        entityType: 'order',
        entityId: closed.order_id,
        before: { offerId, status: 'offered' },
        after: { offerId, status: 'expired', userId: closed.user_id },
      });
    }
    await emit(
      tx,
      'order.offer_closed',
      { offerId, orderId: closed.order_id, userId: closed.user_id, outcome: status },
      { orgId },
    );
    return closed;
  }
}

function OfferGone(message: string): OrdersError {
  return new OrdersError('ORDER_OFFER_GONE', message);
}

async function transactionNow(tx: Tx): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  if (row === undefined) throw new Error('the database did not say what time it is');
  return new Date(row.now);
}
