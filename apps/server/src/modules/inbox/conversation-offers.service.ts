import { Inject, Injectable, Logger } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { pickAssignee, presenceState, type AssignmentCandidate } from '@elysium/domain/assignment';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { TEAM_API, type TeamApi } from '../team/team.api.js';
import { holdsInboxRole } from './inbox-roles.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';
import { INBOX_QUEUES } from './inbox.queues.js';
import * as offers from './offers.repository.js';
import type { ConversationOfferPort } from './ports/conversation-offer.port.js';

/**
 * The inbox's auto-offer (D-748): M41's engine bound to M42's seam (`CONVERSATION_OFFER`).
 *
 * A conversation nobody has whose customer writes is offered to one person at a time, who has
 * the brand's countdown to accept or decline it, exactly as a new order is (D-716, D-717):
 *
 * - **Who.** `pickAssignee` (`@elysium/domain/assignment`) with kind `conversation`, over the
 *   brand's people from `TEAM_API`: active in the ERP and not paused, holding an inbox role
 *   (sales or org_admin, who may hold a conversation, D-736), with **messages** among their
 *   work types (orders are offered only to those with orders), under the brand's cap of open
 *   conversations, not holding a live conversation offer, and not having declined or let lapse
 *   this one. The least loaded wins, then whoever was offered something longest ago.
 * - **When.** Only while the brand auto-assigns: M41's one switch, its countdown and its cap
 *   (Settings → Order workflow, off by default), read through `ORDERS_API`. Switched off, no
 *   conversation is offered and the sweep withdraws every live offer within the minute; an
 *   accept after that is refused.
 * - **Exactly once.** The conversation is locked while it is dispatched; one live offer per
 *   conversation and per person is two partial unique indexes; accepting is one conditional
 *   statement (`acceptOffer`), so a take and an accept cannot both win.
 * - **No external call** (invariant 6): an offer is a row and an outbox event, the deadline a
 *   pg-boss job enqueued in the same transaction.
 *
 * Orders and conversations are offered independently: a person may look at an order card and a
 * conversation card at once, one of each at most.
 */

/** Who the dispatcher acts as, in the audit log and the outbox (`app.user_id`). */
export const CONVERSATION_OFFER_ACTOR = 'system:auto-assign';

/** How many people a dispatcher tries before it gives up on a conversation for now. */
const PICK_ATTEMPTS = 5;

/** How many waiting conversations one sweep or one presence change dispatches. */
const SWEEP_BATCH = 25;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

@Injectable()
export class ConversationOffersService implements ConversationOfferPort {
  private readonly logger = new Logger('ConversationOffersService');

  constructor(
    @Inject(TEAM_API) private readonly team: TeamApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly audit: AuditService,
  ) {}

  // --- the seam: a new message in a conversation nobody has ------------------------------------

  /**
   * Called in the transaction that threaded the message (M42's port). Only queues a dispatch,
   * which runs after the commit, so the webhook's transaction never waits on anyone's offer.
   */
  async offerNew(tx: Tx, orgId: string, conversationId: string): Promise<void> {
    await this.queueDispatch(tx, orgId, conversationId);
  }

  /** Ask the worker to offer this conversation (or, with null, every waiting one) after commit. */
  async queueDispatch(tx: Tx, orgId: string, conversationId: string | null): Promise<void> {
    if (!(await this.orders.workflowSettings(tx, orgId)).autoAssign) return;
    await enqueue(
      tx,
      INBOX_QUEUES.offerDispatch.name,
      { conversationId },
      { orgId, ref: conversationId },
    );
  }

  /** The conversation was taken another way, handed over or closed: its live offer ends. */
  async withdrawFor(tx: Tx, orgId: string, conversationId: string): Promise<void> {
    for (const offer of await offers.withdrawOffersOf(tx, orgId, conversationId)) {
      await this.tellClosed(tx, orgId, offer, 'withdrawn');
    }
  }

  // --- the person's side -----------------------------------------------------------------------

  /** The caller's live conversation offers, with what the card shows. */
  async mine(context: ActiveContext, request: object) {
    scopeHasNoRowDimension(
      request,
      'an offer is addressed to the caller by id; the conversation it names is shown only to them',
    );
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await offers.offerCardsFor(tx, context.orgId, context.userId);
      return {
        items: rows.map((row) => ({
          id: row.id,
          conversationId: row.conversation_id,
          channel: row.channel_kind,
          contactName: row.contact_name,
          lastPreview: row.last_preview,
          unreadCount: row.unread_count,
          offeredAt: iso(row.offered_at),
          expiresAt: iso(row.expires_at),
        })),
      };
    });
  }

  /** Accept: the conversation is the caller's if the offer is live and nobody took it. */
  async accept(context: ActiveContext, request: AuditableRequest, offerId: string) {
    scopeHasNoRowDimension(request, 'an offer is the caller’s own by its user id');
    return mapInboxErrors(async () => {
      const outcome = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx): Promise<{ conversationId: string } | { gone: string }> => {
          const offer = await offers.offerById(tx, context.orgId, offerId);
          if (offer?.user_id !== context.userId) return { gone: 'No such offer.' };
          // The conversation first, then its offer: the order a take and a dispatch lock them
          // in, so an accept racing either waits rather than deadlocks.
          const conversation = await offers.conversationForUpdate(
            tx,
            context.orgId,
            offer.conversation_id,
          );
          const switchedOff = !(await this.orders.workflowSettings(tx, context.orgId)).autoAssign;
          const taken = switchedOff
            ? undefined
            : await offers.acceptOffer(tx, {
                orgId: context.orgId,
                offerId,
                userId: context.userId,
              });
          if (taken === undefined) {
            // Lapsed, answered, auto-assign switched off, or the conversation went another way.
            // A live offer that can no longer be accepted is withdrawn here, so the person's
            // next offer is not held up.
            if (
              offer.status === 'offered' &&
              (switchedOff || conversation?.status !== 'open' || conversation.assigned_to !== null)
            ) {
              const closed = await offers.closeOffer(tx, {
                orgId: context.orgId,
                offerId,
                status: 'withdrawn',
              });
              if (closed !== undefined)
                await this.tellClosed(tx, context.orgId, closed, 'withdrawn');
            }
            return { gone: 'This offer has ended: it ran out, or the conversation was taken.' };
          }
          await this.audit.record(tx, {
            orgId: context.orgId,
            actorUserId: context.userId,
            operation: 'update',
            action: 'inbox.offer_accepted',
            entityType: 'inbox_conversation',
            entityId: taken.conversation_id,
            before: { assignedTo: null, offer: offerId },
            after: { assignedTo: context.userId, offer: offerId },
            request,
          });
          await emit(
            tx,
            'inbox.conversation_offer_closed',
            {
              offerId,
              conversationId: taken.conversation_id,
              userId: context.userId,
              outcome: 'accepted',
            },
            { orgId: context.orgId },
          );
          // Every list and thread hears that the conversation is somebody's now.
          await emit(
            tx,
            'inbox.conversation_changed',
            {
              conversationId: taken.conversation_id,
              assignedTo: context.userId,
              previousAssignee: null,
              status: 'open',
              at: new Date().toISOString(),
            },
            { orgId: context.orgId },
          );
          return { conversationId: taken.conversation_id };
        },
      );
      if ('gone' in outcome) throw offerGone(outcome.gone);
      return { accepted: true, conversationId: outcome.conversationId };
    });
  }

  /** Decline: the conversation goes on to the next person. */
  async decline(context: ActiveContext, request: AuditableRequest, offerId: string) {
    scopeHasNoRowDimension(request, 'an offer is the caller’s own by its user id');
    return mapInboxErrors(async () => {
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
          action: 'inbox.offer_declined',
          entityType: 'inbox_conversation',
          entityId: offer.conversation_id,
          before: { offer: offerId, status: 'offered' },
          after: { offer: offerId, status: 'declined' },
          request,
        });
        await this.tellClosed(tx, context.orgId, offer, 'declined');
        await this.queueDispatch(tx, context.orgId, offer.conversation_id);
        return offer;
      });
      if (closed === undefined) throw offerGone('This offer has already ended.');
      return { declined: true, conversationId: closed.conversation_id };
    });
  }

  // --- the worker --------------------------------------------------------------------------------

  /** Offer one conversation, or with null every waiting one, in the brand. */
  async dispatch(orgId: string, conversationId: string | null): Promise<number> {
    if (conversationId !== null) {
      return withOrg({ orgId, userId: CONVERSATION_OFFER_ACTOR }, async (tx) =>
        (await this.dispatchIn(tx, orgId, conversationId)) ? 1 : 0,
      );
    }
    const waiting = await withOrg({ orgId, userId: CONVERSATION_OFFER_ACTOR }, async (tx) =>
      (await this.orders.workflowSettings(tx, orgId)).autoAssign
        ? offers.waitingConversations(tx, orgId, SWEEP_BATCH)
        : [],
    );
    let offered = 0;
    // One transaction per conversation, so one conversation's trouble never holds the rest.
    for (const id of waiting) {
      const done = await withOrg({ orgId, userId: CONVERSATION_OFFER_ACTOR }, (tx) =>
        this.dispatchIn(tx, orgId, id),
      );
      if (done) offered += 1;
    }
    return offered;
  }

  /** One offer's deadline: expired if still unanswered, and the conversation moves on. */
  async expire(orgId: string, offerId: string): Promise<boolean> {
    return withOrg({ orgId, userId: CONVERSATION_OFFER_ACTOR }, async (tx) => {
      const offer = await offers.offerById(tx, orgId, offerId);
      if (offer?.status !== 'offered') return false;
      // The conversation first, then the offer, the same order a take locks them in.
      await offers.conversationForUpdate(tx, orgId, offer.conversation_id);
      const closed = await offers.closeOffer(tx, {
        orgId,
        offerId,
        status: 'expired',
        onlyIfOverdue: true,
      });
      if (closed === undefined) return false;
      await this.recordExpiry(tx, orgId, closed);
      // The next person by a job after this commits, for the reason M41's expiry gives.
      await this.queueDispatch(tx, orgId, closed.conversation_id);
      return true;
    });
  }

  /**
   * Every minute: in a brand that auto-assigns, lapse what ran out and offer what waits; in one
   * that does not, withdraw whatever is still offered (the switch is M41's, which cannot reach
   * the inbox's tables, D-748).
   */
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
        const facts = await withOrg({ orgId, userId: CONVERSATION_OFFER_ACTOR }, async (tx) => ({
          on: (await this.orders.workflowSettings(tx, orgId)).autoAssign,
          open: await offers.openOffers(tx, orgId, 200),
          overdue: await offers.overdueOffers(tx, orgId, 200),
        }));
        if (!facts.on) {
          for (const row of facts.open) {
            await withOrg({ orgId, userId: CONVERSATION_OFFER_ACTOR }, async (tx) => {
              await offers.conversationForUpdate(tx, orgId, row.conversation_id);
              const closed = await offers.closeOffer(tx, {
                orgId,
                offerId: row.id,
                status: 'withdrawn',
              });
              if (closed !== undefined) await this.tellClosed(tx, orgId, closed, 'withdrawn');
            });
          }
          continue;
        }
        // One lapse per transaction, each locking its own conversation only.
        for (const row of facts.overdue) {
          if (await this.expire(orgId, row.id)) expired += 1;
        }
        brands += 1;
        offered += await this.dispatch(orgId, null);
      } catch (error) {
        // One brand's trouble never holds the others; its next minute tries again.
        this.logger.error({ err: String(error), orgId }, 'conversation offer sweep failed');
      }
    }
    return { brands, expired, offered };
  }

  /**
   * Offer one conversation to the right person, in the caller's transaction. True when an offer
   * was made. Locks the conversation first, so two dispatchers of it run one after the other.
   */
  async dispatchIn(tx: Tx, orgId: string, conversationId: string): Promise<boolean> {
    const settings = await this.orders.workflowSettings(tx, orgId);
    if (!settings.autoAssign) return false;
    const conversation = await offers.conversationForUpdate(tx, orgId, conversationId);
    if (conversation?.status !== 'open' || conversation.assigned_to !== null) return false;
    if ((await offers.liveOfferFor(tx, orgId, conversationId)) !== undefined) return false;
    // Anything past its deadline for this conversation is lapsed first, so it counts as declined.
    for (const row of await offers.overdueOffersOf(tx, orgId, conversationId)) {
      const closed = await offers.closeOffer(tx, {
        orgId,
        offerId: row.id,
        status: 'expired',
        onlyIfOverdue: true,
      });
      if (closed !== undefined) await this.recordExpiry(tx, orgId, closed);
    }

    const now = await transactionNow(tx);
    const [members, loads, lastOffered, busy, declined] = await Promise.all([
      this.team.members(tx, orgId),
      offers.openLoads(tx, orgId),
      offers.lastOfferedAt(tx, orgId),
      // Every unanswered offer counts, lapsed or not, as M41's dispatcher counts them.
      offers.offeredUsers(tx, orgId),
      offers.declinedBy(tx, orgId, conversationId),
    ]);
    const excluded = new Set(declined);
    const candidates: AssignmentCandidate[] = members
      .filter((member) => holdsInboxRole(member.roles))
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
      const picked = pickAssignee({ kind: 'conversation', candidates, declinedBy: excluded });
      if (picked === null) return false;
      const offer = await offers.insertOffer(tx, {
        orgId,
        conversationId,
        userId: picked,
        seconds: settings.offerSeconds,
      });
      if (offer === undefined) {
        // Somebody else's dispatcher offered this person a conversation a moment ago.
        excluded.add(picked);
        continue;
      }
      await this.audit.record(tx, {
        orgId,
        actorUserId: CONVERSATION_OFFER_ACTOR,
        operation: 'create',
        action: 'inbox.conversation_offered',
        entityType: 'inbox_conversation',
        entityId: conversationId,
        after: { offer: offer.id, userId: picked, expiresAt: iso(offer.expires_at) },
      });
      await emit(
        tx,
        'inbox.conversation_offered',
        {
          offerId: offer.id,
          conversationId,
          userId: picked,
          expiresAt: iso(offer.expires_at) ?? '',
        },
        { orgId },
      );
      // The deadline, as a job that starts once it has passed.
      await enqueue(
        tx,
        INBOX_QUEUES.offerExpire.name,
        { offerId: offer.id },
        { orgId, ref: offer.id, startAfter: settings.offerSeconds + 1 },
      );
      return true;
    }
    return false;
  }

  private async recordExpiry(
    tx: Tx,
    orgId: string,
    closed: offers.ConversationOfferRow,
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId,
      actorUserId: CONVERSATION_OFFER_ACTOR,
      operation: 'update',
      action: 'inbox.offer_expired',
      entityType: 'inbox_conversation',
      entityId: closed.conversation_id,
      before: { offer: closed.id, status: 'offered' },
      after: { offer: closed.id, status: 'expired', userId: closed.user_id },
    });
    await this.tellClosed(tx, orgId, closed, 'expired');
  }

  private async tellClosed(
    tx: Tx,
    orgId: string,
    offer: offers.ConversationOfferRow,
    outcome: 'declined' | 'expired' | 'withdrawn',
  ): Promise<void> {
    await emit(
      tx,
      'inbox.conversation_offer_closed',
      { offerId: offer.id, conversationId: offer.conversation_id, userId: offer.user_id, outcome },
      { orgId },
    );
  }
}

function offerGone(message: string): InboxError {
  return new InboxError('INBOX_OFFER_GONE', message);
}

async function transactionNow(tx: Tx): Promise<Date> {
  const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
  if (row === undefined) throw new Error('the database did not say what time it is');
  return new Date(row.now);
}
