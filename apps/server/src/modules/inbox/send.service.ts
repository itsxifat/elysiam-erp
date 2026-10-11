import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { maskPhonesInText } from '@elysium/domain';
import { replyWindow } from '@elysium/domain/inbox';

import { emit } from '../../platform/events/outbox.js';
import { channelTokenBinding, openSecret } from './inbox-secrets.js';
import * as repo from './inbox.repository.js';
import {
  MESSAGING_GATEWAY,
  MessagingError,
  type MessagingGateway,
  type SendTextRequest,
} from './providers/meta-messaging.js';
import { INBOX_SYSTEM_USER } from './webhook.service.js';

/**
 * How long a reply keeps being retried while Meta cannot be reached. The queue tries three
 * times over about a minute (`inbox.queues.ts`); past this the reply is marked failed, so it
 * does not sit as "sending" forever and the agent can send it again.
 */
export const GIVE_UP_AFTER_MS = 90_000;

export type SendOutcome = 'sent' | 'failed' | 'skipped';

/**
 * The send job (M42, D-734, D-746; invariant 6): one queued reply, sent to Meta outside any
 * transaction.
 *
 * 1. In a transaction, the reply is read (locked) and checked: still queued, the window still
 *    open by our clock (the job may run later than the click), the channel switched on with its
 *    id and token. A reply that fails a check is marked failed with the reason and never sent.
 * 2. The transaction ends; the call to Meta happens with no connection held.
 * 3. A second transaction records Meta's id, or the refusal.
 *
 * Meta's Send API takes no idempotency key, so a reply whose result could not be recorded (the
 * process died between 2 and 3) is sent again on the retry. That is the accepted cost (D-746).
 */
@Injectable()
export class InboxSendService {
  constructor(@Inject(MESSAGING_GATEWAY) private readonly gateway: MessagingGateway) {}

  async send(
    orgId: string,
    messageId: string,
    now: () => Date = () => new Date(),
  ): Promise<SendOutcome> {
    const prepared = await withOrg({ orgId, userId: INBOX_SYSTEM_USER }, (tx) =>
      this.prepare(tx, orgId, messageId, now()),
    );
    if (prepared === null) return 'skipped';
    if ('failed' in prepared) return 'failed';

    let providerMessageId: string;
    try {
      providerMessageId = (await this.gateway.sendText(prepared.request)).providerMessageId;
    } catch (error) {
      const failure =
        error instanceof MessagingError
          ? error
          : new MessagingError('The message could not be sent.', true, null, null);
      const createdAt = await withOrg({ orgId, userId: INBOX_SYSTEM_USER }, (tx) =>
        repo.messageCreatedAt(tx, orgId, messageId),
      );
      const exhausted =
        createdAt === null || now().getTime() - createdAt.getTime() > GIVE_UP_AFTER_MS;
      if (failure.retryable && !exhausted) throw failure;
      await withOrg({ orgId, userId: INBOX_SYSTEM_USER }, (tx) =>
        this.fail(tx, orgId, prepared.conversationId, messageId, {
          code:
            failure.metaCode !== null
              ? `meta:${String(failure.metaCode)}`
              : failure.retryable
                ? 'meta_unreachable'
                : 'meta_refused',
          detail: maskPhonesInText(failure.message),
        }),
      );
      return 'failed';
    }

    await withOrg({ orgId, userId: INBOX_SYSTEM_USER }, async (tx) => {
      if (await repo.markSent(tx, orgId, messageId, providerMessageId)) {
        await emit(
          tx,
          'inbox.message_status',
          { conversationId: prepared.conversationId, messageId, status: 'sent' },
          { orgId },
        );
      }
    });
    return 'sent';
  }

  private async prepare(
    tx: Tx,
    orgId: string,
    messageId: string,
    now: Date,
  ): Promise<
    | { readonly request: SendTextRequest; readonly conversationId: string }
    | { readonly failed: true }
    | null
  > {
    const message = await repo.outboundForSend(tx, orgId, messageId);
    if (message?.status !== 'queued' || message.provider_message_id !== null) {
      return null;
    }
    const conversationId = message.conversation_id;
    const lastInbound = message.last_inbound_at === null ? null : new Date(message.last_inbound_at);
    const window = replyWindow(message.channel_kind, lastInbound, now);
    if (!window.open) {
      await this.fail(tx, orgId, conversationId, messageId, {
        code: 'window_closed',
        detail: 'The 24-hour window closed before the reply could be sent.',
      });
      return { failed: true };
    }

    const channel = await repo.channelById(tx, orgId, message.channel_id);
    // Instagram, through the Messenger API, sends from the Facebook Page linked to it (D-731).
    const sender =
      message.channel_kind === 'instagram'
        ? await repo.channelByKind(tx, orgId, 'messenger')
        : channel;
    const tokenRow =
      message.channel_kind === 'instagram' && channel?.access_token_sealed != null
        ? channel
        : sender;
    const token =
      tokenRow === undefined
        ? null
        : openSecret(tokenRow.access_token_sealed, channelTokenBinding(orgId, tokenRow.kind));
    if (
      channel === undefined ||
      !channel.enabled ||
      sender === undefined ||
      !sender.enabled ||
      token === null ||
      message.body === null
    ) {
      await this.fail(tx, orgId, conversationId, messageId, {
        code: 'channel_not_ready',
        detail: 'The channel is switched off, or its id or token is not set.',
      });
      return { failed: true };
    }

    return {
      conversationId,
      request: {
        channel: message.channel_kind,
        senderId: sender.external_id,
        token,
        recipientId: message.recipient_id,
        text: message.body,
      },
    };
  }

  private async fail(
    tx: Tx,
    orgId: string,
    conversationId: string,
    messageId: string,
    error: { readonly code: string; readonly detail: string | null },
  ): Promise<void> {
    if (await repo.markFailed(tx, orgId, messageId, error)) {
      await emit(
        tx,
        'inbox.message_status',
        { conversationId, messageId, status: 'failed' },
        { orgId },
      );
    }
  }
}
