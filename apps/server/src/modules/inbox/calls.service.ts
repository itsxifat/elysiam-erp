import { Inject, Injectable, Logger } from '@nestjs/common';
import { defineAbilityFor, type InboxCallAnswerInput } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { maskPhonesInText } from '@elysium/domain';
import {
  callAfter,
  CALL_RING_TIMEOUT_MS,
  isCallFinished,
  needsCallBack,
  ringTargets,
  statusAfterTermination,
  type CallStatus,
} from '@elysium/domain/inbox';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { TEAM_API, type TeamApi } from '../team/team.api.js';
import type { CallConnectEvent, CallEvent, CallTerminateEvent } from './call-payload.js';
import { channelSender } from './channel-sender.js';
import { ConversationsService } from './conversations.service.js';
import { holdsInboxRole } from './inbox-roles.js';
import { InboxError } from './inbox.errors.js';
import * as repo from './inbox.repository.js';
import { MessagingError } from './providers/meta-messaging.js';
import { META_MEDIA_GATEWAY, type MetaMediaGateway } from './providers/meta-media.js';
import { VOICE_CALLS_CONFIG, type VoiceCallsConfig } from './voice-calls.config.js';
import { mapVoiceCallErrors } from './voice-calls.errors.js';
import { VOICE_CALLS_QUEUES } from './voice-calls.queues.js';
import * as calls from './voice-calls.repository.js';

const iso = (value: string | Date | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const gone = () => new InboxError('INBOX_CALL_GONE', 'This call is over.');

/**
 * Calls to the brand (M45, D-784 to D-788): Meta's call webhooks recorded and rung on the
 * console, picked up by one agent and answered in their browser over WebRTC (the SDP passes
 * through here to Meta's Calling API), declined, hung up, timed out, and the missed ones left as
 * a call-back item in the conversation.
 *
 * Every call to Meta happens with no transaction open (invariant 6): the call is read and locked
 * in one transaction, Meta is called, and the outcome is written in another. Answering is a
 * person waiting on a ringing phone, so it is not a job: the request waits for Meta's answer
 * (D-787).
 */
@Injectable()
export class InboxCallsService {
  private readonly logger = new Logger('InboxCallsService');

  constructor(
    @Inject(META_MEDIA_GATEWAY) private readonly gateway: MetaMediaGateway,
    @Inject(TEAM_API) private readonly team: TeamApi,
    @Inject(IAM_API) private readonly iam: IamApi,
    @Inject(VOICE_CALLS_CONFIG) private readonly config: VoiceCallsConfig,
    private readonly conversations: ConversationsService,
    private readonly audit: AuditService,
  ) {}

  // --- Meta's webhooks, inside the webhook's processing transaction ------------------------------

  /** One call event from a signed webhook. Returns how many calls it opened or moved. */
  async onWebhook(tx: Tx, orgId: string, channelId: string, event: CallEvent): Promise<number> {
    if (!this.config.INBOX_CALLS_ENABLED) return 0;
    return event.kind === 'call_connect'
      ? this.connected(tx, orgId, channelId, event)
      : this.terminated(tx, orgId, channelId, event);
  }

  private async conversationOf(
    tx: Tx,
    orgId: string,
    channelId: string,
    userId: string,
    profileName: string | null,
    at: Date,
  ): Promise<string> {
    const identity = await repo.ensureIdentity(tx, orgId, channelId, userId, profileName);
    const conversation = await repo.ensureConversation(tx, orgId, {
      channelId,
      contactId: identity.contactId,
      identityId: identity.id,
      at,
    });
    return conversation.id;
  }

  /** The call's entry in the thread: a message whose one attachment names the call. */
  private async threadEntry(
    tx: Tx,
    orgId: string,
    entry: {
      readonly callId: string;
      readonly conversationId: string;
      readonly providerCallId: string;
      readonly channel: 'messenger' | 'whatsapp';
      readonly at: Date;
      readonly missed: boolean;
    },
  ): Promise<void> {
    const messageId = await repo.insertMessage(tx, orgId, {
      conversationId: entry.conversationId,
      direction: 'inbound',
      body: null,
      attachments: [{ type: 'call', callId: entry.callId }],
      providerMessageId: `call:${entry.providerCallId}`.slice(0, 256),
      status: 'received',
      sentBy: null,
      occurredAt: entry.at,
    });
    if (messageId !== undefined) await calls.setCallMessage(tx, orgId, entry.callId, messageId);
    const touched = await calls.touchForCall(tx, orgId, entry.conversationId, {
      at: entry.at,
      preview: entry.missed ? '[missed call]' : '[call]',
      unread: entry.missed,
    });
    await emit(
      tx,
      'inbox.message_received',
      {
        conversationId: entry.conversationId,
        channel: entry.channel,
        assignedTo: touched?.assigned_to ?? null,
        at: entry.at.toISOString(),
      },
      { orgId },
    );
  }

  private async connected(
    tx: Tx,
    orgId: string,
    channelId: string,
    event: CallConnectEvent,
  ): Promise<number> {
    if ((await calls.callByProviderId(tx, orgId, event.providerCallId)) !== undefined) return 0;
    const conversationId = await this.conversationOf(
      tx,
      orgId,
      channelId,
      event.userId,
      event.profileName,
      event.occurredAt,
    );
    const now = new Date();
    // A connect Meta delivered after the caller's ring would have run out cannot be answered.
    const stale = now.getTime() - event.occurredAt.getTime() > CALL_RING_TIMEOUT_MS;
    const conversation = await repo.conversationById(tx, orgId, conversationId);
    const members = stale ? [] : await this.team.members(tx, orgId);
    const rang = stale
      ? []
      : ringTargets({
          ownerUserId: conversation?.assigned_to ?? null,
          candidates: members.map((member) => ({
            userId: member.userId,
            holdsInboxRole: holdsInboxRole(member.roles),
            workTypes: member.workTypes,
            presence: member.presence,
          })),
          now,
        });
    const callId = await calls.insertCall(tx, orgId, {
      conversationId,
      channelId,
      providerCallId: event.providerCallId,
      status: stale ? 'missed' : 'ringing',
      offerSdp: stale ? null : event.offerSdp,
      rangUserIds: rang,
      startedAt: event.occurredAt,
      endedAt: stale ? now : null,
      callbackNeeded: stale,
    });
    if (callId === undefined) return 0;
    await this.threadEntry(tx, orgId, {
      callId,
      conversationId,
      providerCallId: event.providerCallId,
      channel: event.channel,
      at: event.occurredAt,
      missed: stale,
    });
    if (!stale) {
      await emit(
        tx,
        'inbox.call_ringing',
        {
          callId,
          conversationId,
          channel: event.channel,
          userIds: [...rang],
          at: event.occurredAt.toISOString(),
        },
        { orgId },
      );
      await enqueue(
        tx,
        VOICE_CALLS_QUEUES.callTimeout.name,
        { callId },
        { orgId, ref: callId, startAfter: Math.ceil(CALL_RING_TIMEOUT_MS / 1000) },
      );
    }
    return 1;
  }

  private async terminated(
    tx: Tx,
    orgId: string,
    channelId: string,
    event: CallTerminateEvent,
  ): Promise<number> {
    const termination = { status: event.status, durationSeconds: event.durationSeconds };
    const call = await calls.callByProviderId(tx, orgId, event.providerCallId);
    if (call === undefined) {
      // We never heard it ring (a lost connect, or calls were off): record it, over.
      if (event.userId === null) return 0;
      const conversationId = await this.conversationOf(
        tx,
        orgId,
        channelId,
        event.userId,
        event.profileName,
        event.endedAt,
      );
      const status = statusAfterTermination('ringing', termination);
      const startedAt = new Date(event.endedAt.getTime() - (event.durationSeconds ?? 0) * 1000);
      const callId = await calls.insertCall(tx, orgId, {
        conversationId,
        channelId,
        providerCallId: event.providerCallId,
        status,
        offerSdp: null,
        rangUserIds: [],
        startedAt,
        endedAt: event.endedAt,
        durationSeconds: event.durationSeconds,
        callbackNeeded: needsCallBack(status, 'inbound'),
      });
      if (callId === undefined) return 0;
      await this.threadEntry(tx, orgId, {
        callId,
        conversationId,
        providerCallId: event.providerCallId,
        channel: event.channel,
        at: startedAt,
        missed: status === 'missed',
      });
      return 1;
    }

    if (isCallFinished(call.status)) {
      // Our own hang-up or refusal came first; Meta adds when it ended and how long it ran.
      await calls.recordCallEnd(tx, orgId, call.id, {
        endedAt: event.endedAt,
        durationSeconds: event.durationSeconds,
        endReason: event.errorCode,
      });
      await this.changed(tx, orgId, call, call.status, call.answered_by);
      return 1;
    }
    const next = statusAfterTermination(call.status, termination);
    await this.finish(tx, orgId, call, next, {
      endedAt: event.endedAt,
      durationSeconds: event.durationSeconds,
      endReason: event.errorCode,
    });
    return 1;
  }

  /** A live call ends: recorded, the call-back left when missed, everyone it rang told. */
  private async finish(
    tx: Tx,
    orgId: string,
    call: calls.CallRow,
    status: CallStatus,
    end: {
      readonly endedAt: Date;
      readonly durationSeconds: number | null;
      readonly endReason: string | null;
      readonly declinedBy?: string | null;
    },
  ): Promise<void> {
    const callback = needsCallBack(status, call.direction);
    await calls.finishCall(tx, orgId, call.id, { status, ...end, callbackNeeded: callback });
    if (callback) {
      await calls.touchForCall(tx, orgId, call.conversation_id, {
        at: end.endedAt,
        preview: '[missed call]',
        unread: true,
      });
    }
    const answeredBy = status === 'missed' || status === 'declined' ? null : call.answered_by;
    await this.changed(tx, orgId, call, status, answeredBy);
  }

  private async changed(
    tx: Tx,
    orgId: string,
    call: calls.CallRow,
    status: CallStatus,
    answeredBy: string | null,
  ): Promise<void> {
    const people = new Set(call.rang_user_ids);
    if (call.answered_by !== null) people.add(call.answered_by);
    await emit(
      tx,
      'inbox.call_changed',
      {
        callId: call.id,
        conversationId: call.conversation_id,
        status,
        answeredBy,
        userIds: [...people].slice(0, 100),
      },
      { orgId },
    );
  }

  /** The job: a call still ringing past its deadline is missed (D-786). */
  async timeout(orgId: string, callId: string, now: Date = new Date()): Promise<boolean> {
    return withOrg({ orgId, userId: 'system:inbox' }, async (tx) => {
      const call = await calls.callById(tx, orgId, callId, { lock: true });
      if (call === undefined) return false;
      const next = callAfter(call.status, 'time_out');
      if (next === null) return false;
      if (now.getTime() - new Date(call.started_at).getTime() < CALL_RING_TIMEOUT_MS) return false;
      await this.finish(tx, orgId, call, next, {
        endedAt: now,
        durationSeconds: null,
        endReason: 'timeout',
      });
      return true;
    });
  }

  // --- the agent's side -----------------------------------------------------------------------------

  private async names(tx: Tx, orgId: string): Promise<Map<string, string>> {
    return new Map(await this.iam.nameBook(tx, orgId));
  }

  private view(
    call: calls.CallRow,
    names: Map<string, string>,
    me: string,
    options: { readonly withOffer?: boolean } = {},
  ) {
    const person = (userId: string | null) =>
      userId === null ? null : { userId, name: names.get(userId) ?? null };
    return {
      id: call.id,
      conversationId: call.conversation_id,
      channel: call.channel_kind,
      direction: call.direction,
      status: call.status,
      contact: { name: call.contact_name },
      startedAt: new Date(call.started_at).toISOString(),
      connectedAt: iso(call.connected_at),
      endedAt: iso(call.ended_at),
      durationSeconds: call.duration_seconds,
      answeredBy: person(call.answered_by),
      declinedBy: person(call.declined_by),
      ringingForMe: call.status === 'ringing' && call.rang_user_ids.includes(me),
      mine: call.answered_by === me,
      callbackNeeded: call.callback_needed,
      callbackDoneBy: person(call.callback_done_by),
      callbackDoneAt: iso(call.callback_done_at),
      // WhatsApp's caller id is their number: a missed call can be returned by phone (D-788).
      callbackPhone: call.channel_kind === 'whatsapp' ? `+${call.external_user_id}` : null,
      // Only to the person answering it, and only while it can still be answered.
      ...(options.withOffer === true ? { offerSdp: call.offer_sdp } : {}),
    };
  }

  /** The calls ringing for the caller, and the one they are on. */
  async live(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await calls.liveCallsFor(tx, context.orgId, context.userId);
      const names = await this.names(tx, context.orgId);
      return { items: rows.map((row) => this.view(row, names, context.userId)) };
    });
  }

  async one(context: ActiveContext, callId: string) {
    return mapVoiceCallErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await calls.callById(tx, context.orgId, callId);
        if (call === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such call.');
        return this.view(call, await this.names(tx, context.orgId), context.userId);
      }),
    );
  }

  /** Whoever it rang, whoever has the conversation, or a supervisor may pick it up. */
  private assertMayAnswer(context: ActiveContext, call: calls.CallRow): void {
    if (call.rang_user_ids.includes(context.userId)) return;
    if (call.assigned_to === context.userId) return;
    if (defineAbilityFor(context).can('update', 'ConversationAssignment')) return;
    throw new InboxError('INBOX_CALL_GONE', 'This call is not ringing for you.');
  }

  private async record(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    call: calls.CallRow,
    action: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: `inbox.call_${action}`,
      entityType: 'inbox_call',
      entityId: call.id,
      before: { status: call.status },
      after: { ...after, conversation: call.conversation_id },
      requestId: context.requestId,
      request,
    });
  }

  /**
   * Pick a ringing call up (D-787): one conditional update, so of two agents clicking Answer one
   * gets the call (and, for WhatsApp, Meta's SDP offer) and the other is told who has it. A
   * conversation nobody has becomes the answerer's, as a reply makes it.
   */
  async claim(context: ActiveContext, request: AuditableRequest, callId: string) {
    return mapVoiceCallErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await calls.callById(tx, context.orgId, callId, { lock: true });
        if (call === undefined) throw gone();
        this.assertMayAnswer(context, call);
        const names = await this.names(tx, context.orgId);
        if (call.status === 'answering' && call.answered_by === context.userId) {
          return this.view(call, names, context.userId, { withOffer: true });
        }
        if (isCallFinished(call.status)) throw gone();
        if (!(await calls.claimCall(tx, context.orgId, callId, context.userId))) {
          const who = call.answered_by === null ? null : (names.get(call.answered_by) ?? null);
          throw new InboxError(
            'INBOX_CALL_TAKEN',
            `${who ?? 'A colleague'} has already picked this call up.`,
          );
        }
        if (call.assigned_to === null) {
          if (
            await repo.takeIfUnassigned(tx, context.orgId, call.conversation_id, context.userId)
          ) {
            await emit(
              tx,
              'inbox.conversation_changed',
              {
                conversationId: call.conversation_id,
                assignedTo: context.userId,
                previousAssignee: null,
                status: 'open',
                at: new Date().toISOString(),
              },
              { orgId: context.orgId },
            );
          }
        }
        await this.record(tx, context, request, call, 'claim', { status: 'answering' });
        await this.changed(tx, context.orgId, call, 'answering', context.userId);
        const claimed = await calls.callById(tx, context.orgId, callId);
        if (claimed === undefined) throw gone();
        return this.view(claimed, names, context.userId, { withOffer: true });
      }),
    );
  }

  /**
   * The browser's session to Meta (D-787): WhatsApp's `pre_accept` then `accept` with the
   * browser's SDP answer; Messenger's `accept` with the browser's offer, answered with Meta's.
   * Only by whoever picked the call up. Meta is called with no transaction open.
   */
  async answer(
    context: ActiveContext,
    request: AuditableRequest,
    callId: string,
    input: InboxCallAnswerInput,
  ) {
    return mapVoiceCallErrors(async () => {
      const prepared = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const call = await calls.callById(tx, context.orgId, callId);
          if (call?.status !== 'answering' || call.answered_by !== context.userId) throw gone();
          const sender = await channelSender(tx, context.orgId, call.channel_kind, call.channel_id);
          if (sender === null || call.channel_kind === 'instagram') {
            throw new InboxError(
              'INBOX_CHANNEL_NOT_READY',
              'This channel is switched off, or its token is not set, in Settings → Inbox.',
            );
          }
          return { call, sender, channel: call.channel_kind };
        },
      );
      let result: { sdpAnswer: string | null; sdpRenegotiation: string | null };
      try {
        result = await this.gateway.callAction({
          channel: prepared.channel,
          senderId: prepared.sender.senderId,
          token: prepared.sender.token,
          providerCallId: prepared.call.provider_call_id,
          action: input.step,
          sdp: input.sdp,
        });
      } catch (error) {
        throw this.metaFailed(error, 'answer');
      }
      if (input.step === 'pre_accept') {
        return { status: 'answering' as const, sdpAnswer: null, sdpRenegotiation: null };
      }
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await calls.callById(tx, context.orgId, callId, { lock: true });
        if (call === undefined) return;
        if (await calls.connectCall(tx, context.orgId, callId, context.userId)) {
          await this.record(tx, context, request, call, 'answer', { status: 'connected' });
          await this.changed(tx, context.orgId, call, 'connected', context.userId);
        }
      });
      return { status: 'connected' as const, ...result };
    });
  }

  /** The browser could not connect (no microphone, no network): the call rings again. */
  async release(context: ActiveContext, request: AuditableRequest, callId: string) {
    return mapVoiceCallErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await calls.callById(tx, context.orgId, callId, { lock: true });
        if (call === undefined) throw gone();
        if (!(await calls.releaseCall(tx, context.orgId, callId, context.userId))) throw gone();
        await this.record(tx, context, request, call, 'release', { status: 'ringing' });
        await this.changed(tx, context.orgId, call, 'ringing', null);
        return { id: callId, status: 'ringing' as const };
      }),
    );
  }

  /** Refuse a ringing call (Meta's `reject`), or one picked up and not yet connected. */
  async decline(context: ActiveContext, request: AuditableRequest, callId: string) {
    return mapVoiceCallErrors(async () => {
      const prepared = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const call = await calls.callById(tx, context.orgId, callId);
          if (call === undefined || callAfter(call.status, 'decline') === null) throw gone();
          this.assertMayAnswer(context, call);
          if (call.status === 'answering' && call.answered_by !== context.userId) {
            throw new InboxError('INBOX_CALL_TAKEN', 'A colleague has picked this call up.');
          }
          const sender = await channelSender(tx, context.orgId, call.channel_kind, call.channel_id);
          return { call, sender };
        },
      );
      if (prepared.sender !== null && prepared.call.channel_kind !== 'instagram') {
        try {
          await this.gateway.callAction({
            channel: prepared.call.channel_kind,
            senderId: prepared.sender.senderId,
            token: prepared.sender.token,
            providerCallId: prepared.call.provider_call_id,
            action: 'reject',
          });
        } catch (error) {
          throw this.metaFailed(error, 'decline');
        }
      }
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await calls.callById(tx, context.orgId, callId, { lock: true });
        if (call === undefined) throw gone();
        if (callAfter(call.status, 'decline') !== null) {
          await this.finish(tx, context.orgId, call, 'declined', {
            endedAt: new Date(),
            durationSeconds: null,
            endReason: null,
            declinedBy: context.userId,
          });
          await this.record(tx, context, request, call, 'decline', { status: 'declined' });
        }
        return { id: callId, status: 'declined' as const };
      });
    });
  }

  /**
   * Hang up (Meta's `terminate`). Recorded even when Meta cannot be reached: the browser has
   * already closed its connection, and Meta ends a call that stops carrying media.
   */
  async hangUp(context: ActiveContext, request: AuditableRequest, callId: string) {
    return mapVoiceCallErrors(async () => {
      const prepared = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const call = await calls.callById(tx, context.orgId, callId);
          if (call?.answered_by !== context.userId) throw gone();
          if (callAfter(call.status, 'hang_up') === null) throw gone();
          const sender = await channelSender(tx, context.orgId, call.channel_kind, call.channel_id);
          return { call, sender };
        },
      );
      if (prepared.sender !== null && prepared.call.channel_kind !== 'instagram') {
        try {
          await this.gateway.callAction({
            channel: prepared.call.channel_kind,
            senderId: prepared.sender.senderId,
            token: prepared.sender.token,
            providerCallId: prepared.call.provider_call_id,
            action: 'terminate',
          });
        } catch (error) {
          this.logger.warn(
            { callId, reason: error instanceof Error ? maskPhonesInText(error.message) : 'error' },
            'Meta did not take a hang-up; recorded anyway',
          );
        }
      }
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await calls.callById(tx, context.orgId, callId, { lock: true });
        if (call === undefined) throw gone();
        const next = callAfter(call.status, 'hang_up');
        if (next !== null && call.answered_by === context.userId) {
          const now = new Date();
          const seconds =
            call.connected_at === null
              ? null
              : Math.max(
                  0,
                  Math.round((now.getTime() - new Date(call.connected_at).getTime()) / 1000),
                );
          await this.finish(tx, context.orgId, call, next, {
            endedAt: now,
            durationSeconds: seconds,
            endReason: null,
          });
          await this.record(tx, context, request, call, 'hang_up', { status: next });
        }
        return { id: callId, status: next ?? call.status };
      });
    });
  }

  /**
   * A missed call dealt with (called back, or no need): a write on the conversation, so someone
   * else's needs the acknowledgement and tells its owner, as every inbox write does (D-737).
   */
  async callbackDone(
    context: ActiveContext,
    request: AuditableRequest,
    callId: string,
    acknowledged: boolean,
  ) {
    return mapVoiceCallErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const call = await calls.callById(tx, context.orgId, callId);
        if (call === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such call.');
        const { ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          call.conversation_id,
          acknowledged,
        );
        const done = await calls.markCallbackDone(tx, context.orgId, callId, context.userId);
        if (done) {
          await this.conversations.recordWrite(tx, context, request, {
            action: 'call_back',
            conversationId: call.conversation_id,
            ownership,
            entityType: 'inbox_call',
            entityId: callId,
            after: { callbackDone: true },
          });
          await this.changed(tx, context.orgId, call, call.status, call.answered_by);
        }
        return { id: callId, callbackNeeded: false };
      }),
    );
  }

  private metaFailed(error: unknown, what: string): InboxError {
    const detail =
      error instanceof MessagingError
        ? maskPhonesInText(error.message)
        : 'Meta could not be reached.';
    return new InboxError(
      'INBOX_CALL_FAILED',
      `Meta did not take the ${what}: ${detail}`,
      error instanceof MessagingError && error.retryable ? 'meta_unreachable' : 'meta_refused',
    );
  }
}
