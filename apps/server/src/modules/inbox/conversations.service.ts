import { Inject, Injectable } from '@nestjs/common';
import {
  defineAbilityFor,
  type InboxHandOverInput,
  type InboxListQuery,
  type InboxReplyInput,
  type InboxThreadQuery,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { replyWindow, type ReplyWindow } from '@elysium/domain/inbox';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { channelTokenBinding, openSecret } from './inbox-secrets.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';
import { INBOX_QUEUES } from './inbox.queues.js';
import * as repo from './inbox.repository.js';
import { INBOX_ROLES } from './inbox-roles.js';
import { ConversationOffersService } from './conversation-offers.service.js';
import { ownershipFor, type Ownership } from './ownership.js';
import { previewOf } from './webhook-payload.js';

export { INBOX_ROLES } from './inbox-roles.js';

export interface PersonRef {
  readonly userId: string;
  /** Null for someone this brand does not list by name (an owner, a former member). */
  readonly name: string | null;
}

export interface WindowView {
  readonly open: boolean;
  /** While open: when it closes. When closed: when it closed, or null if they never wrote. */
  readonly closesAt: string | null;
  readonly reason: 'never_wrote' | 'expired' | null;
}

function windowView(window: ReplyWindow): WindowView {
  return window.open
    ? { open: true, closesAt: window.closesAt.toISOString(), reason: null }
    : {
        open: false,
        closesAt: window.closedAt === null ? null : window.closedAt.toISOString(),
        reason: window.reason,
      };
}

const iso = (value: string | Date | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/**
 * The inbox's conversations (M42, D-736, D-737): the list, a thread, taking, releasing and
 * handing over, closing, and replying. Every write locks the conversation's row first, so two
 * people taking it at once are served one after the other and the second sees who has it.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly audit: AuditService,
    @Inject(IAM_API) private readonly iam: IamApi,
    // D-748: a conversation taken, handed over or closed another way ends its live offer.
    private readonly offers: ConversationOffersService,
  ) {}

  private async names(tx: Tx, orgId: string): Promise<Map<string, string>> {
    const members = await this.iam.activeMembers(tx, orgId);
    return new Map(members.map((member) => [member.userId, member.name]));
  }

  private person(names: Map<string, string>, userId: string | null): PersonRef | null {
    return userId === null ? null : { userId, name: names.get(userId) ?? null };
  }

  private listItem(row: repo.ConversationRow, names: Map<string, string>, now: Date) {
    return {
      id: row.id,
      channel: row.channel_kind,
      status: row.status,
      contact: {
        id: row.contact_id,
        name: row.display_name ?? row.profile_name,
        stage: row.stage,
      },
      assignedTo: this.person(names, row.assigned_to),
      assignedAt: iso(row.assigned_at),
      lastMessageAt: new Date(row.last_message_at).toISOString(),
      lastPreview: row.last_preview,
      lastDirection: row.last_direction,
      unreadCount: row.unread_count,
      window: windowView(
        replyWindow(
          row.channel_kind,
          row.last_inbound_at === null ? null : new Date(row.last_inbound_at),
          now,
        ),
      ),
    };
  }

  async list(context: ActiveContext, query: InboxListQuery) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const digits = query.q?.replace(/\D/g, '') ?? '';
        const rows = await repo.listConversations(tx, context.orgId, {
          view: query.view,
          userId: context.userId,
          channel: query.channel,
          stage: query.stage,
          status: query.status,
          unread: query.unread,
          q:
            query.q === undefined
              ? undefined
              : {
                  name: query.q,
                  phoneDigits: digits.length >= 4 ? digits.replace(/^0/, '') : null,
                },
          before: query.before,
          limit: query.limit + 1,
        });
        const names = await this.names(tx, context.orgId);
        const now = new Date();
        const page = rows.slice(0, query.limit);
        return {
          items: page.map((row) => this.listItem(row, names, now)),
          nextBefore:
            rows.length > query.limit && page.length > 0
              ? new Date(page[page.length - 1]?.last_message_at ?? 0).toISOString()
              : null,
        };
      }),
    );
  }

  async thread(context: ActiveContext, id: string, query: InboxThreadQuery) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.conversationById(tx, context.orgId, id);
        if (row === undefined) throw notFound();
        const messages = await repo.messagesOf(tx, context.orgId, id, {
          before: query.before,
          limit: query.limit + 1,
        });
        const names = await this.names(tx, context.orgId);
        const hasMore = messages.length > query.limit;
        const shown = hasMore ? messages.slice(messages.length - query.limit) : messages;
        return {
          conversation: this.listItem(row, names, new Date()),
          messages: shown.map((message) => ({
            id: message.id,
            direction: message.direction,
            text: message.body,
            attachments: Array.isArray(message.attachments) ? message.attachments : [],
            status: message.status,
            sentBy: this.person(names, message.sent_by),
            at: new Date(message.occurred_at).toISOString(),
            sentAt: iso(message.sent_at),
            deliveredAt: iso(message.delivered_at),
            readAt: iso(message.read_at),
            error:
              message.error_code === null
                ? null
                : { code: message.error_code, detail: message.error_detail },
          })),
          hasMore,
        };
      }),
    );
  }

  /** People who can be handed a conversation: active sales and org admins of this brand. */
  async team(context: ActiveContext) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const members = await this.iam.activeMembers(tx, context.orgId, { roles: INBOX_ROLES });
        return {
          items: members
            .map((member) => ({ userId: member.userId, name: member.name, roles: member.roles }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      }),
    );
  }

  // --- ownership --------------------------------------------------------------------------------

  /**
   * Lock the conversation and decide whose it is for this write. Shared with the contact panel,
   * whose writes go through the conversation so the same rule applies to them.
   */
  async lockForWrite(
    tx: Tx,
    context: ActiveContext,
    id: string,
    acknowledged: boolean,
  ): Promise<{ readonly row: repo.ConversationRow; readonly ownership: Ownership }> {
    const row = await repo.conversationById(tx, context.orgId, id, { lock: true });
    if (row === undefined) throw notFound();
    const ownerName =
      row.assigned_to === null || row.assigned_to === context.userId
        ? null
        : ((await this.names(tx, context.orgId)).get(row.assigned_to) ?? null);
    return {
      row,
      ownership: ownershipFor(row.assigned_to, context.userId, acknowledged, ownerName),
    };
  }

  /**
   * The audit row for an inbox write, inside its transaction, saying whose conversation it was
   * when the writer acknowledged someone else's; and the owner told (D-737).
   */
  async recordWrite(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    write: {
      readonly action: string;
      readonly conversationId: string;
      readonly ownership: Ownership;
      readonly entityType?: string;
      readonly entityId?: string;
      readonly before?: Record<string, unknown> | null;
      readonly after?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const acknowledgedOwner =
      write.ownership.kind === 'acknowledged' ? write.ownership.ownerUserId : null;
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: `inbox.${write.action}`,
      entityType: write.entityType ?? 'inbox_conversation',
      entityId: write.entityId ?? write.conversationId,
      before: write.before ?? null,
      after: {
        ...(write.after ?? {}),
        // `conversation`, not `conversationId`: the redactor reads any key holding `nid`
        // (a national id) as secret, and `conversationId` holds it.
        conversation: write.conversationId,
        ...(acknowledgedOwner === null ? {} : { acknowledgedOwner }),
      },
      requestId: context.requestId,
      request,
    });
    if (acknowledgedOwner !== null) {
      await emit(
        tx,
        'inbox.owner_overridden',
        {
          conversationId: write.conversationId,
          ownerUserId: acknowledgedOwner,
          actorUserId: context.userId,
          action: write.action,
        },
        { orgId: context.orgId },
      );
    }
  }

  /**
   * Who a conversation belongs to changes only by its owner, or by a supervisor (D-737): taking
   * over, releasing or handing over someone else's needs `update ConversationAssignment` as well
   * as the acknowledgement. Covering a colleague's thread (a reply, a note) needs only the latter.
   */
  private assertMayReassign(context: ActiveContext, ownership: Ownership): void {
    if (ownership.kind !== 'acknowledged') return;
    if (defineAbilityFor(context).can('update', 'ConversationAssignment')) return;
    throw new InboxError(
      'INBOX_HANDOVER_NOT_ALLOWED',
      'Only whoever has this conversation, or a supervisor, gives it to someone else.',
    );
  }

  private async changed(
    tx: Tx,
    orgId: string,
    conversationId: string,
    assignedTo: string | null,
    previousAssignee: string | null,
    status: 'open' | 'closed',
  ): Promise<void> {
    await emit(
      tx,
      'inbox.conversation_changed',
      {
        conversationId,
        assignedTo,
        previousAssignee: previousAssignee === assignedTo ? null : previousAssignee,
        status,
        at: new Date().toISOString(),
      },
      { orgId },
    );
  }

  async take(context: ActiveContext, request: AuditableRequest, id: string, acknowledged: boolean) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.lockForWrite(tx, context, id, acknowledged);
        this.assertMayReassign(context, ownership);
        if (ownership.kind !== 'owner') {
          if (ownership.kind === 'unassigned') {
            await repo.takeIfUnassigned(tx, context.orgId, id, context.userId);
          } else {
            await repo.setAssignee(tx, context.orgId, id, context.userId);
          }
          await this.changed(tx, context.orgId, id, context.userId, row.assigned_to, row.status);
          await this.offers.withdrawFor(tx, context.orgId, id);
        }
        await this.recordWrite(tx, context, request, {
          action: 'take',
          conversationId: id,
          ownership,
          before: { assignedTo: row.assigned_to },
          after: { assignedTo: context.userId },
        });
        return { id, assignedTo: context.userId };
      }),
    );
  }

  async release(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.lockForWrite(tx, context, id, acknowledged);
        this.assertMayReassign(context, ownership);
        if (row.assigned_to !== null) {
          await repo.setAssignee(tx, context.orgId, id, null);
          await this.changed(tx, context.orgId, id, null, row.assigned_to, row.status);
          // Back to nobody: offered to the next person while the brand auto-assigns (D-748).
          if (row.status === 'open') await this.offers.queueDispatch(tx, context.orgId, id);
        }
        await this.recordWrite(tx, context, request, {
          action: 'release',
          conversationId: id,
          ownership,
          before: { assignedTo: row.assigned_to },
          after: { assignedTo: null },
        });
        return { id, assignedTo: null };
      }),
    );
  }

  /**
   * Hand a conversation to someone (D-737). The owner hands over their own; one nobody has can
   * be given to anyone; someone else's needs a supervisor (`update ConversationAssignment`) and,
   * like every write on someone else's, the acknowledgement.
   */
  async handOver(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: InboxHandOverInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.lockForWrite(tx, context, id, acknowledged);
        this.assertMayReassign(context, ownership);
        const team = await this.iam.activeMembers(tx, context.orgId, { roles: INBOX_ROLES });
        if (!team.some((member) => member.userId === input.userId)) {
          throw new InboxError(
            'INBOX_ASSIGNEE_INVALID',
            'That person does not answer this brand’s inbox.',
          );
        }
        if (row.assigned_to !== input.userId) {
          await repo.setAssignee(tx, context.orgId, id, input.userId);
          await this.changed(tx, context.orgId, id, input.userId, row.assigned_to, row.status);
          await this.offers.withdrawFor(tx, context.orgId, id);
        }
        await this.recordWrite(tx, context, request, {
          action: 'hand_over',
          conversationId: id,
          ownership,
          before: { assignedTo: row.assigned_to },
          after: { assignedTo: input.userId },
        });
        return { id, assignedTo: input.userId };
      }),
    );
  }

  async setStatus(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    status: 'open' | 'closed',
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.lockForWrite(tx, context, id, acknowledged);
        if (row.status !== status) {
          await repo.setConversationStatus(tx, context.orgId, id, status);
          await this.changed(tx, context.orgId, id, row.assigned_to, row.assigned_to, status);
          if (status === 'closed') await this.offers.withdrawFor(tx, context.orgId, id);
        }
        await this.recordWrite(tx, context, request, {
          action: status === 'closed' ? 'close' : 'reopen',
          conversationId: id,
          ownership,
          before: { status: row.status },
          after: { status },
        });
        return { id, status };
      }),
    );
  }

  /**
   * The owner has read the thread: its unread count goes to zero. Anyone else opening it changes
   * nothing (it is still unread for the person whose it is), so this needs no acknowledgement.
   */
  async markRead(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.conversationById(tx, context.orgId, id, { lock: true });
        if (row === undefined) throw notFound();
        const mine = row.assigned_to === context.userId;
        if (mine) await repo.markConversationRead(tx, context.orgId, id);
        await this.recordWrite(tx, context, request, {
          action: 'read',
          conversationId: id,
          ownership: { kind: mine ? 'owner' : 'unassigned' },
          after: { cleared: mine && row.unread_count > 0 },
        });
        return { id, unreadCount: mine ? 0 : row.unread_count };
      }),
    );
  }

  /**
   * A reply (D-734, D-746; invariant 6): refused outside the window, written `queued`, and sent
   * by `inbox.send_message` after the commit. Replying in a conversation nobody has takes it.
   * The browser's id makes a retried reply one message.
   */
  async reply(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: InboxReplyInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.lockForWrite(tx, context, id, acknowledged);

        const existing = await repo.messageById(tx, context.orgId, input.id);
        if (existing !== undefined) {
          if (existing.conversation_id !== id || existing.sent_by !== context.userId) {
            throw new InboxError('INBOX_INVALID', 'That message id is already used.');
          }
          return { id: existing.id, status: existing.status, replayed: true };
        }

        const now = new Date();
        const window = replyWindow(
          row.channel_kind,
          row.last_inbound_at === null ? null : new Date(row.last_inbound_at),
          now,
        );
        if (!window.open) {
          throw new InboxError(
            'INBOX_WINDOW_CLOSED',
            window.reason === 'never_wrote'
              ? 'This person has not written to the brand, so a free-text reply cannot be sent. They have to write first.'
              : `The 24-hour reply window closed at ${window.closedAt?.toISOString() ?? 'an earlier time'}. Meta allows free text only within 24 hours of the customer's last message; they have to write again first.`,
            window.reason === 'never_wrote' ? 'never_wrote' : 'window_expired',
          );
        }
        await this.assertChannelReady(tx, context.orgId, row);

        if (ownership.kind === 'unassigned') {
          await repo.takeIfUnassigned(tx, context.orgId, id, context.userId);
          await this.changed(tx, context.orgId, id, context.userId, null, row.status);
        }

        const messageId = await repo.insertMessage(tx, context.orgId, {
          id: input.id,
          conversationId: id,
          direction: 'outbound',
          body: input.text,
          attachments: [],
          providerMessageId: null,
          status: 'queued',
          sentBy: context.userId,
          occurredAt: now,
        });
        if (messageId === undefined) {
          throw new InboxError('INBOX_INVALID', 'That message id is already used.');
        }
        await repo.touchConversation(tx, context.orgId, id, {
          direction: 'outbound',
          at: now,
          preview: previewOf(input.text, []),
        });
        await enqueue(
          tx,
          INBOX_QUEUES.sendMessage.name,
          { messageId },
          {
            orgId: context.orgId,
            ref: messageId,
            singletonKey: `send:${messageId}`,
            requestId: context.requestId,
          },
        );
        await emit(
          tx,
          'inbox.message_status',
          { conversationId: id, messageId, status: 'queued' },
          { orgId: context.orgId },
        );
        await this.recordWrite(tx, context, request, {
          action: 'reply',
          conversationId: id,
          ownership,
          entityType: 'inbox_message',
          entityId: messageId,
          after: { length: input.text.length },
        });
        return { id: messageId, status: 'queued' as const, replayed: false };
      }),
    );
  }

  /** The channel can send: on, with its id and token (Instagram: the Page's too). */
  private async assertChannelReady(
    tx: Tx,
    orgId: string,
    row: repo.ConversationRow,
  ): Promise<void> {
    const channel = await repo.channelById(tx, orgId, row.channel_id);
    const sender =
      row.channel_kind === 'instagram' ? await repo.channelByKind(tx, orgId, 'messenger') : channel;
    const tokenRow =
      row.channel_kind === 'instagram' && channel?.access_token_sealed != null ? channel : sender;
    const ready =
      channel?.enabled === true &&
      sender?.enabled === true &&
      tokenRow?.access_token_fingerprint != null &&
      openSecret(tokenRow.access_token_sealed, channelTokenBinding(orgId, tokenRow.kind)) !== null;
    if (!ready) {
      throw new InboxError(
        'INBOX_CHANNEL_NOT_READY',
        row.channel_kind === 'instagram'
          ? 'Instagram replies go through the Facebook Page: set up the Page and its token in Settings → Inbox.'
          : 'This channel is switched off, or its token is not set, in Settings → Inbox.',
      );
    }
  }
}

function notFound(): InboxError {
  return new InboxError('INBOX_NOT_FOUND', 'No such conversation.');
}
