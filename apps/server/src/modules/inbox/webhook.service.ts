import { createHash, timingSafeEqual } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { nextOutboundStatus } from '@elysium/domain/inbox';
import { maskPhonesInText } from '@elysium/domain';

import { emit } from '../../platform/events/outbox.js';
import { createLogger } from '../../platform/logging/logger.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { appSecretBinding, openSecret, verifyTokenBinding } from './inbox-secrets.js';
import { INBOX_QUEUES } from './inbox.queues.js';
import * as repo from './inbox.repository.js';
import { CONVERSATION_OFFER, type ConversationOfferPort } from './ports/conversation-offer.port.js';
import { metaSignatureMatches } from './signature.js';
import {
  parseMetaWebhook,
  previewOf,
  WEBHOOK_OBJECTS,
  type MessageEvent,
  type ReceiptEvent,
  type WebhookObject,
} from './webhook-payload.js';

/** Who the database sees acting when a webhook is processed. Not a person. */
export const INBOX_SYSTEM_USER = 'system:inbox';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a processed body came to, kept on its row. */
export interface ProcessOutcome extends Record<string, number> {
  threaded: number;
  echoes: number;
  duplicates: number;
  receipts: number;
  unknownChannel: number;
  skipped: number;
}

function refused(): UnauthorizedException {
  // One answer for every refusal: a public endpoint that told a wrong org from a wrong secret
  // would help a stranger find the shape of a real request (as the courier webhook says).
  return new UnauthorizedException({
    code: 'WEBHOOK_SIGNATURE_INVALID',
    message: 'That webhook was not accepted.',
  });
}

function sameSecret(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Meta's webhook into the inbox (M42, D-732): the subscription check, the signed body stored
 * first and enqueued in the same transaction, and the job that threads it into conversations.
 */
@Injectable()
export class InboxWebhookService {
  private cachedLogger: ReturnType<typeof createLogger> | undefined;

  private get logger(): ReturnType<typeof createLogger> {
    this.cachedLogger ??= createLogger('inbox');
    return this.cachedLogger;
  }

  constructor(@Inject(CONVERSATION_OFFER) private readonly offer: ConversationOfferPort) {}

  /**
   * Graph API Webhooks › Getting started: Meta sends `hub.mode=subscribe`, the verify token
   * entered in the App Dashboard and `hub.challenge`, and expects the challenge echoed. A wrong
   * token, or a brand with none set, is a 403 (as the Messenger page says).
   */
  async verifySubscription(
    orgIdParam: string,
    query: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const forbidden = () =>
      new ForbiddenException({ code: 'FORBIDDEN', message: 'Verification refused.' });
    if (!UUID.test(orgIdParam) || mode !== 'subscribe' || typeof token !== 'string') {
      throw forbidden();
    }
    // Meta documents an int; anything else is not echoed back from a public endpoint.
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(challenge)) {
      throw forbidden();
    }
    const orgId = orgIdParam;
    const settings = await withOrg({ orgId }, (tx) => repo.settingsOf(tx, orgId));
    const expected = openSecret(settings?.verify_token_sealed ?? null, verifyTokenBinding(orgId));
    if (expected === null || !sameSecret(token, expected)) throw forbidden();
    return challenge;
  }

  /**
   * A signed event notification. Verified with the brand's app secret before anything is
   * stored; stored once by its hash (Meta retries a body it thinks failed); processed by
   * `inbox.process_webhook` after the commit (the integration rules: store first, process in a
   * job). Meta wants a 200 within seconds, so nothing slow happens here.
   */
  async accept(
    orgIdParam: string,
    rawBody: Buffer,
    signature: string | undefined,
    body: unknown,
  ): Promise<{ readonly accepted: true; readonly duplicate: boolean }> {
    if (!UUID.test(orgIdParam) || rawBody.length === 0) throw refused();
    const orgId = orgIdParam;
    const settings = await withOrg({ orgId }, (tx) => repo.settingsOf(tx, orgId));
    const secret = openSecret(settings?.app_secret_sealed ?? null, appSecretBinding(orgId));
    if (secret === null || !metaSignatureMatches(rawBody, signature, secret)) throw refused();

    const object = (WEBHOOK_OBJECTS as readonly string[]).includes(
      String((body as { object?: unknown } | null)?.object),
    )
      ? (body as { object: WebhookObject }).object
      : null;
    // Signed by the brand's own app, but about something the inbox does not read (a feed
    // change, a page rating): acknowledged so Meta stops retrying it, and not stored.
    if (object === null) return { accepted: true, duplicate: false };

    const sha256 = createHash('sha256').update(rawBody).digest('hex');
    return withOrg({ orgId }, async (tx) => {
      const stored = await repo.storeWebhook(tx, orgId, object, sha256, body);
      if (!stored.duplicate) {
        await enqueue(
          tx,
          INBOX_QUEUES.processWebhook.name,
          { eventId: stored.id },
          {
            orgId,
            ref: stored.id,
            singletonKey: `webhook:${stored.id}`,
          },
        );
      }
      return { accepted: true as const, duplicate: stored.duplicate };
    });
  }

  /** The job: thread one stored body into conversations, once. */
  async process(orgId: string, eventId: string): Promise<ProcessOutcome | null> {
    return withOrg({ orgId, userId: INBOX_SYSTEM_USER }, async (tx) => {
      const row = await repo.webhookForProcessing(tx, orgId, eventId);
      if (row?.processed_at !== null) return null;

      const parsed = parseMetaWebhook(row.body);
      const channels = new Map((await repo.channelsOf(tx, orgId)).map((c) => [c.kind, c]));
      const outcome: ProcessOutcome = {
        threaded: 0,
        echoes: 0,
        duplicates: 0,
        receipts: 0,
        unknownChannel: 0,
        skipped: parsed.skipped,
      };

      for (const event of parsed.events) {
        const channel = channels.get(event.channel);
        // A channel this brand has not set up, switched off, or another account's id: the
        // signature proved the app, not that this account is the brand's.
        if (channel === undefined || !channel.enabled || channel.external_id !== event.accountId) {
          outcome.unknownChannel += 1;
          continue;
        }
        if (event.kind === 'message') {
          await this.thread(tx, orgId, channel.id, event, outcome);
        } else {
          outcome.receipts += await this.applyReceipt(tx, orgId, channel.id, event);
        }
      }

      await repo.markWebhookProcessed(tx, orgId, eventId, outcome);
      // Counts only: never a sender, a phone or the words.
      if (outcome.unknownChannel > 0) {
        this.logger.warn(
          { eventId, ...outcome },
          'inbox webhook named an account that is not one of this brand’s switched-on channels',
        );
      } else {
        this.logger.debug({ eventId, ...outcome }, 'inbox webhook threaded');
      }
      return outcome;
    });
  }

  private async thread(
    tx: Tx,
    orgId: string,
    channelId: string,
    event: MessageEvent,
    outcome: ProcessOutcome,
  ): Promise<void> {
    const identity = await repo.ensureIdentity(
      tx,
      orgId,
      channelId,
      event.userId,
      event.profileName,
    );
    const conversation = await repo.ensureConversation(tx, orgId, {
      channelId,
      contactId: identity.contactId,
      identityId: identity.id,
      at: event.occurredAt,
    });

    if (event.echo && (await this.isOwnReplyInFlight(tx, orgId, conversation.id, event.text))) {
      // Our own reply, echoed back before the send job recorded Meta's id for it (D-745).
      outcome.duplicates += 1;
      return;
    }

    const messageId = await repo.insertMessage(tx, orgId, {
      conversationId: conversation.id,
      direction: event.echo ? 'outbound' : 'inbound',
      body: event.text,
      attachments: event.attachments.map((attachment) => ({ ...attachment })),
      providerMessageId: event.providerMessageId,
      status: event.echo ? 'sent' : 'received',
      sentBy: null,
      occurredAt: event.occurredAt,
      sentAt: event.echo ? event.occurredAt : null,
    });
    if (messageId === undefined) {
      outcome.duplicates += 1;
      return;
    }

    const touched = await repo.touchConversation(tx, orgId, conversation.id, {
      direction: event.echo ? 'outbound' : 'inbound',
      at: event.occurredAt,
      preview: previewOf(event.text, event.attachments),
    });
    const assignedTo = touched?.assigned_to ?? null;
    await emit(
      tx,
      'inbox.message_received',
      {
        conversationId: conversation.id,
        channel: event.channel,
        assignedTo,
        at: event.occurredAt.toISOString(),
      },
      { orgId },
    );
    if (event.echo) outcome.echoes += 1;
    else {
      outcome.threaded += 1;
      if (assignedTo === null) await this.offer.offerNew(tx, orgId, conversation.id);
    }
  }

  /** A reply of ours with these words is still waiting for its send job to record Meta's id. */
  private async isOwnReplyInFlight(
    tx: Tx,
    orgId: string,
    conversationId: string,
    text: string | null,
  ): Promise<boolean> {
    if (text === null) return false;
    const recent = await repo.messagesOf(tx, orgId, conversationId, { limit: 20 });
    return recent.some(
      (message) =>
        message.direction === 'outbound' &&
        message.sent_by !== null &&
        message.status === 'queued' &&
        message.body === text,
    );
  }

  /** Delivery and read receipts, and WhatsApp's statuses. Returns how many messages moved. */
  private async applyReceipt(
    tx: Tx,
    orgId: string,
    channelId: string,
    event: ReceiptEvent,
  ): Promise<number> {
    const targets = [
      ...(await repo.outboundByProviderIds(tx, orgId, event.providerMessageIds)),
      ...(event.watermark === null
        ? []
        : await repo.outboundUpTo(tx, orgId, channelId, event.userId, event.watermark)),
    ];
    const seen = new Set<string>();
    let moved = 0;
    for (const target of targets) {
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      const next = nextOutboundStatus(target.status, event.status);
      if (next === target.status) continue;
      await repo.applyStatus(
        tx,
        orgId,
        target.id,
        next,
        event.occurredAt,
        next === 'failed' && event.error !== null
          ? {
              code: event.error.code.slice(0, 40),
              detail: event.error.detail === null ? null : maskPhonesInText(event.error.detail),
            }
          : null,
      );
      await emit(
        tx,
        'inbox.message_status',
        { conversationId: target.conversation_id, messageId: target.id, status: next },
        { orgId },
      );
      moved += 1;
    }
    return moved;
  }
}
