import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InboxVoiceInput } from '@elysium/contracts';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { maskPhonesInText } from '@elysium/domain';
import {
  isRecordingMime,
  keptMediaKind,
  MAX_KEPT_BYTES,
  replyWindow,
  voiceFormatFor,
  type KeptMediaKind,
} from '@elysium/domain/inbox';
import { sniffMime } from '@elysium/integrations';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { channelSender } from './channel-sender.js';
import { ConversationsService } from './conversations.service.js';
import { InboxError } from './inbox.errors.js';
import * as repo from './inbox.repository.js';
import { MessagingError } from './providers/meta-messaging.js';
import {
  MediaTooLarge,
  META_MEDIA_GATEWAY,
  type MetaMediaGateway,
} from './providers/meta-media.js';
import { transcodeVoice, TranscodeFailed } from './transcode.js';
import { VOICE_CALLS_CONFIG, type VoiceCallsConfig } from './voice-calls.config.js';
import { mapVoiceCallErrors } from './voice-calls.errors.js';
import { VOICE_CALLS_QUEUES } from './voice-calls.queues.js';
import * as media from './voice-calls.repository.js';

/** Who the database sees acting in the media jobs. Not a person. */
const SYSTEM = 'system:inbox';
const PURPOSE = 'inbox-media' as const;
/** A recording the composer uploads is a two-minute voice note: a few hundred kilobytes. */
const MAX_RECORDING_BYTES = 8 * 1024 * 1024;
/** How long a voice message keeps being retried while Meta cannot be reached (M42's rule). */
const GIVE_UP_AFTER_MS = 120_000;
/** Downloads tried this often before the attachment is marked failed. */
const FETCH_ATTEMPTS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MediaOutcome = 'stored' | 'failed' | 'skipped';
export type VoiceOutcome = 'sent' | 'failed' | 'skipped';

/**
 * Record a just-threaded message's audio and pictures for keeping, and ask the worker to fetch
 * each after the commit (D-780). Called in the webhook's transaction; nothing slow happens here.
 */
export async function queueInboundMedia(
  tx: Tx,
  orgId: string,
  message: {
    readonly messageId: string;
    readonly conversationId: string;
    readonly attachments: readonly { readonly type: string }[];
    readonly occurredAt: Date;
  },
): Promise<number> {
  let queued = 0;
  for (const [position, attachment] of message.attachments.entries()) {
    const kind = keptMediaKind(attachment.type);
    if (kind === null || position > 9) continue;
    const id = await media.insertMedia(tx, orgId, {
      messageId: message.messageId,
      conversationId: message.conversationId,
      position,
      kind,
      direction: 'inbound',
      status: 'pending',
      fileId: null,
      mime: null,
      sizeBytes: null,
      durationMs: null,
      occurredAt: message.occurredAt,
    });
    if (id === undefined) continue;
    await enqueue(
      tx,
      VOICE_CALLS_QUEUES.fetchMedia.name,
      { mediaId: id },
      { orgId, ref: id, singletonKey: `media:${id}` },
    );
    queued += 1;
  }
  return queued;
}

/** D-745 for voice: an echo of ours, sent from here, arriving before its send job finished. */
export async function isOwnVoiceEcho(
  tx: Tx,
  orgId: string,
  conversationId: string,
  event: { readonly text: string | null; readonly attachments: readonly { type: string }[] },
): Promise<boolean> {
  if (event.text !== null || !event.attachments.some((item) => item.type === 'audio')) {
    return false;
  }
  return media.voiceInFlight(tx, orgId, conversationId);
}

/**
 * The type a downloaded attachment is kept as: what its bytes sniff as, with an audio file's
 * container named as audio (a WebM or an MP4 holding only sound sniffs as the video type).
 */
export function keptMime(kind: KeptMediaKind, sniffed: string | null): string | null {
  if (kind === 'image') {
    return sniffed === 'image/jpeg' || sniffed === 'image/png' || sniffed === 'image/webp'
      ? sniffed
      : null;
  }
  switch (sniffed) {
    case 'audio/ogg':
    case 'audio/mp4':
    case 'audio/mpeg':
    case 'audio/aac':
      return sniffed;
    case 'video/mp4':
      return 'audio/mp4';
    case 'video/webm':
      return 'audio/webm';
    case null:
    default:
      return null;
  }
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * The inbox's media (M45, D-780 to D-783): what customers send kept before Meta's link expires,
 * played to staff through an authorised route; voice messages recorded in the browser, converted
 * and sent through Meta by a job; and the retention rule.
 */
@Injectable()
export class InboxMediaService {
  private readonly logger = new Logger('InboxMediaService');

  constructor(
    @Inject(META_MEDIA_GATEWAY) private readonly gateway: MetaMediaGateway,
    @Inject(FILES_API) private readonly files: FilesApi,
    @Inject(VOICE_CALLS_CONFIG) private readonly config: VoiceCallsConfig,
    private readonly conversations: ConversationsService,
  ) {}

  // --- keeping what a customer sent ---------------------------------------------------------------

  /** The job: download one attachment and keep it as a private file. */
  async fetch(orgId: string, mediaId: string): Promise<MediaOutcome> {
    const prepared = await withOrg({ orgId, userId: SYSTEM }, async (tx) => {
      const row = await media.mediaForFetch(tx, orgId, mediaId);
      if (row === undefined || row.status === 'stored' || row.status === 'expired') return null;
      const attachment = row.attachment ?? {};
      const url = typeof attachment.url === 'string' ? attachment.url : undefined;
      const metaMediaId = typeof attachment.mediaId === 'string' ? attachment.mediaId : undefined;
      let token: string | null = null;
      if (row.channel_kind === 'whatsapp') {
        token = (await channelSender(tx, orgId, 'whatsapp', row.channel_id))?.token ?? null;
      }
      const source =
        row.channel_kind === 'whatsapp'
          ? metaMediaId !== undefined && token !== null
          : url !== undefined;
      if (!source) {
        await this.failMedia(tx, orgId, row, 'no_source');
        return null;
      }
      return { row, url, metaMediaId, token };
    });
    if (prepared === null) return 'skipped';
    const { row } = prepared;

    let download: { bytes: Uint8Array };
    try {
      download = await this.gateway.download({
        channel: row.channel_kind,
        mediaId: prepared.metaMediaId,
        url: prepared.url,
        token: prepared.token,
        maxBytes: MAX_KEPT_BYTES[row.kind],
      });
    } catch (error) {
      const retryable = error instanceof MessagingError && error.retryable;
      if (retryable && row.attempts + 1 < FETCH_ATTEMPTS) {
        await withOrg({ orgId, userId: SYSTEM }, (tx) =>
          media.bumpMediaAttempts(tx, orgId, mediaId),
        );
        throw error;
      }
      const code =
        error instanceof MediaTooLarge
          ? 'too_large'
          : retryable
            ? 'meta_unreachable'
            : 'meta_refused';
      await withOrg({ orgId, userId: SYSTEM }, (tx) => this.failMedia(tx, orgId, row, code));
      return 'failed';
    }

    const mime = keptMime(row.kind, sniffMime(download.bytes));
    if (mime === null) {
      await withOrg({ orgId, userId: SYSTEM }, (tx) =>
        this.failMedia(tx, orgId, row, 'unsupported'),
      );
      return 'failed';
    }
    let stored: { fileId: string; sizeBytes: number };
    try {
      stored = await this.files.storeProduced({
        orgId,
        ownerUserId: null,
        purpose: PURPOSE,
        mime,
        originalName: `${row.kind}-${row.id}.${EXTENSIONS[mime] ?? 'bin'}`,
        bytes: download.bytes,
      });
    } catch (error) {
      // The files module refused the bytes (not what they claim, too large): not kept.
      this.logger.warn(
        { mediaId, reason: error instanceof Error ? error.message : 'error' },
        'inbox media refused by the files module',
      );
      await withOrg({ orgId, userId: SYSTEM }, (tx) =>
        this.failMedia(tx, orgId, row, 'unsupported'),
      );
      return 'failed';
    }
    const kept = await withOrg({ orgId, userId: SYSTEM }, async (tx) => {
      const ok = await media.markMediaStored(tx, orgId, mediaId, {
        fileId: stored.fileId,
        mime,
        sizeBytes: stored.sizeBytes,
      });
      if (!ok) {
        // Kept by an earlier run meanwhile: this copy is forgotten with the transaction.
        await this.files.forget(tx, orgId, stored.fileId, PURPOSE);
        return false;
      }
      await emit(
        tx,
        'inbox.media_ready',
        { conversationId: row.conversation_id, messageId: row.message_id, status: 'stored' },
        { orgId },
      );
      return true;
    });
    return kept ? 'stored' : 'skipped';
  }

  private async failMedia(
    tx: Tx,
    orgId: string,
    row: media.MediaForFetch,
    code: string,
  ): Promise<void> {
    await media.markMediaFailed(tx, orgId, row.id, code);
    await emit(
      tx,
      'inbox.media_ready',
      { conversationId: row.conversation_id, messageId: row.message_id, status: 'failed' },
      { orgId },
    );
  }

  /**
   * The bytes of a kept attachment, for a person who reads the inbox (`read Conversation`, the
   * route's ability). Found through its kept-attachment row, so only the inbox's files are
   * served here, and only a stored one.
   */
  async serve(context: ActiveContext, fileId: string) {
    return mapVoiceCallErrors(async () => {
      const found = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        media.mediaByFile(tx, context.orgId, fileId),
      );
      if (found?.status !== 'stored') {
        throw new InboxError('INBOX_NOT_FOUND', 'No such voice message or picture.');
      }
      const bytes = await this.files.storedBytes(context.orgId, fileId, PURPOSE);
      if (bytes === null) {
        throw new InboxError('INBOX_NOT_FOUND', 'No such voice message or picture.');
      }
      return bytes;
    });
  }

  // --- sending a recorded voice message -----------------------------------------------------------

  /**
   * A voice message recorded in the browser (D-781): refused outside the 24-hour window like any
   * reply, written `queued` with its recording, and sent by `inbox.send_voice` after the commit.
   * The recording is a stored `inbox-media` file the caller uploaded; replying in a conversation
   * nobody has takes it, as a text reply does (D-737).
   */
  async sendVoiceMessage(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxVoiceInput,
    acknowledged: boolean,
  ) {
    return mapVoiceCallErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const existing = await repo.messageById(tx, context.orgId, input.id);
        if (existing !== undefined) {
          if (existing.conversation_id !== conversationId || existing.sent_by !== context.userId) {
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
              ? 'This person has not written to the brand, so a voice message cannot be sent. They have to write first.'
              : `The 24-hour reply window closed at ${window.closedAt?.toISOString() ?? 'an earlier time'}. Meta allows a reply only within 24 hours of the customer's last message.`,
            window.reason === 'never_wrote' ? 'never_wrote' : 'window_expired',
          );
        }
        if ((await channelSender(tx, context.orgId, row.channel_kind, row.channel_id)) === null) {
          throw new InboxError(
            'INBOX_CHANNEL_NOT_READY',
            'This channel is switched off, or its token is not set, in Settings → Inbox.',
          );
        }

        const facts = await this.files.fileFacts(tx, context.orgId, input.fileId);
        if (
          facts?.purpose !== PURPOSE ||
          facts.status !== 'stored' ||
          facts.ownerUserId !== context.userId ||
          !isRecordingMime(facts.mime) ||
          (facts.sizeBytes ?? 0) > MAX_RECORDING_BYTES
        ) {
          throw new InboxError('INBOX_MEDIA_INVALID', 'That recording is not one you uploaded.');
        }
        if ((await media.mediaByFile(tx, context.orgId, input.fileId)) !== undefined) {
          throw new InboxError('INBOX_MEDIA_INVALID', 'That recording was already sent.');
        }

        if (ownership.kind === 'unassigned') {
          await repo.takeIfUnassigned(tx, context.orgId, conversationId, context.userId);
          await emit(
            tx,
            'inbox.conversation_changed',
            {
              conversationId,
              assignedTo: context.userId,
              previousAssignee: null,
              status: row.status,
              at: now.toISOString(),
            },
            { orgId: context.orgId },
          );
        }

        const messageId = await repo.insertMessage(tx, context.orgId, {
          id: input.id,
          conversationId,
          direction: 'outbound',
          body: null,
          attachments: [
            {
              type: 'audio',
              fileId: input.fileId,
              mimeType: facts.mime,
              durationMs: String(input.durationMs),
            },
          ],
          providerMessageId: null,
          status: 'queued',
          sentBy: context.userId,
          occurredAt: now,
        });
        if (messageId === undefined) {
          throw new InboxError('INBOX_INVALID', 'That message id is already used.');
        }
        await media.insertMedia(tx, context.orgId, {
          messageId,
          conversationId,
          position: 0,
          kind: 'audio',
          direction: 'outbound',
          status: 'stored',
          fileId: input.fileId,
          mime: facts.mime,
          sizeBytes: facts.sizeBytes,
          durationMs: input.durationMs,
          occurredAt: now,
        });
        await repo.touchConversation(tx, context.orgId, conversationId, {
          direction: 'outbound',
          at: now,
          preview: '[voice message]',
        });
        await enqueue(
          tx,
          VOICE_CALLS_QUEUES.sendVoice.name,
          { messageId },
          {
            orgId: context.orgId,
            ref: messageId,
            singletonKey: `voice:${messageId}`,
            requestId: context.requestId,
          },
        );
        await emit(
          tx,
          'inbox.message_status',
          { conversationId, messageId, status: 'queued' },
          { orgId: context.orgId },
        );
        await this.conversations.recordWrite(tx, context, request, {
          action: 'voice',
          conversationId,
          ownership,
          entityType: 'inbox_message',
          entityId: messageId,
          after: { durationMs: input.durationMs },
        });
        return { id: messageId, status: 'queued' as const, replayed: false };
      }),
    );
  }

  /**
   * The job: one queued voice message converted to its channel's format and sent (D-781;
   * invariant 6). Checked in a transaction (still queued, the window still open, the channel
   * ready, the recording there), then read, converted and sent with no transaction open, then
   * recorded. A refusal is final; an unreachable Meta is retried for two minutes, as text is.
   */
  async sendVoice(
    orgId: string,
    messageId: string,
    now: () => Date = () => new Date(),
  ): Promise<VoiceOutcome> {
    const prepared = await withOrg({ orgId, userId: SYSTEM }, async (tx) => {
      const message = await repo.outboundForSend(tx, orgId, messageId);
      if (message?.status !== 'queued' || message.provider_message_id !== null) return null;
      const conversationId = message.conversation_id;
      const window = replyWindow(
        message.channel_kind,
        message.last_inbound_at === null ? null : new Date(message.last_inbound_at),
        now(),
      );
      if (!window.open) {
        await this.failMessage(tx, orgId, conversationId, messageId, {
          code: 'window_closed',
          detail: 'The 24-hour window closed before the voice message could be sent.',
        });
        return null;
      }
      const sender = await channelSender(tx, orgId, message.channel_kind, message.channel_id);
      const file = await media.voiceFileOf(tx, orgId, messageId);
      if (sender === null || file?.file_id == null) {
        await this.failMessage(tx, orgId, conversationId, messageId, {
          code: sender === null ? 'channel_not_ready' : 'media_missing',
          detail:
            sender === null
              ? 'The channel is switched off, or its id or token is not set.'
              : 'The recording is gone.',
        });
        return null;
      }
      return {
        conversationId,
        channel: message.channel_kind,
        recipientId: message.recipient_id,
        sender,
        fileId: file.file_id,
      };
    });
    if (prepared === null) return 'skipped';

    const fail = async (code: string, detail: string): Promise<VoiceOutcome> => {
      await withOrg({ orgId, userId: SYSTEM }, (tx) =>
        this.failMessage(tx, orgId, prepared.conversationId, messageId, { code, detail }),
      );
      return 'failed';
    };

    const recording = await this.files.storedBytes(orgId, prepared.fileId, PURPOSE);
    if (recording === null) return fail('media_missing', 'The recording is gone.');
    const format = voiceFormatFor(prepared.channel);
    let converted: Uint8Array;
    try {
      converted = await transcodeVoice(recording.bytes, format, {
        ffmpegPath: this.config.FFMPEG_PATH,
      });
    } catch (error) {
      if (error instanceof TranscodeFailed) {
        this.logger.warn({ messageId, reason: error.message }, 'a voice message did not convert');
        return fail('transcode_failed', 'The recording could not be converted for this channel.');
      }
      throw error;
    }

    let providerMessageId: string;
    try {
      providerMessageId = (
        await this.gateway.sendVoice({
          channel: prepared.channel,
          senderId: prepared.sender.senderId,
          token: prepared.sender.token,
          recipientId: prepared.recipientId,
          bytes: converted,
          mime: format.mime,
          filename: `voice.${format.extension}`,
          voiceNote: format.voiceNote,
        })
      ).providerMessageId;
    } catch (error) {
      const failure =
        error instanceof MessagingError
          ? error
          : new MessagingError('The voice message could not be sent.', true, null, null);
      const createdAt = await withOrg({ orgId, userId: SYSTEM }, (tx) =>
        repo.messageCreatedAt(tx, orgId, messageId),
      );
      const exhausted =
        createdAt === null || now().getTime() - createdAt.getTime() > GIVE_UP_AFTER_MS;
      if (failure.retryable && !exhausted) throw failure;
      return fail(
        failure.metaCode !== null
          ? `meta:${String(failure.metaCode)}`
          : failure.retryable
            ? 'meta_unreachable'
            : 'meta_refused',
        maskPhonesInText(failure.message),
      );
    }

    await withOrg({ orgId, userId: SYSTEM }, async (tx) => {
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

  private async failMessage(
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

  // --- retention (D-783) ----------------------------------------------------------------------------

  /**
   * Every brand's kept media older than the retention rule deleted (the row stays, `expired`),
   * and every `inbox-media` upload a day old that no message took (a recording never sent)
   * forgotten. A brand that fails is logged and the next is still done.
   */
  async retention(now: Date = new Date()): Promise<{ expired: number; swept: number }> {
    const orgIds = await withGlobal((tx) => media.allOrgIds(tx));
    let expired = 0;
    let swept = 0;
    const before = new Date(now.getTime() - this.config.INBOX_MEDIA_RETENTION_DAYS * DAY_MS);
    for (const orgId of orgIds) {
      try {
        for (;;) {
          const done = await withOrg({ orgId, userId: SYSTEM }, async (tx) => {
            const rows = await media.expiredMedia(tx, orgId, before, 200);
            for (const row of rows) {
              await media.expireMedia(tx, orgId, row.id);
              await this.files.forget(tx, orgId, row.file_id, PURPOSE);
            }
            return rows.length;
          });
          expired += done;
          if (done < 200) break;
        }
        swept += await this.sweepOrphans(orgId, new Date(now.getTime() - DAY_MS));
      } catch (error) {
        this.logger.error(
          { orgId, reason: error instanceof Error ? error.message : String(error) },
          'inbox media retention failed for a brand',
        );
      }
    }
    return { expired, swept };
  }

  private async sweepOrphans(orgId: string, before: Date): Promise<number> {
    let after: { createdAt: string; id: string } | null = null;
    let swept = 0;
    for (;;) {
      const page: readonly { id: string; createdAt: string }[] = await withOrg(
        { orgId, userId: SYSTEM },
        (tx) => this.files.filesOfPurposeBefore(tx, orgId, PURPOSE, before, { after, limit: 200 }),
      );
      if (page.length === 0) break;
      swept += await withOrg({ orgId, userId: SYSTEM }, async (tx) => {
        const kept = await media.referencedFiles(
          tx,
          orgId,
          page.map((file) => file.id),
        );
        let forgotten = 0;
        for (const file of page) {
          if (kept.has(file.id)) continue;
          if (await this.files.forget(tx, orgId, file.id, PURPOSE)) forgotten += 1;
        }
        return forgotten;
      });
      const last = page[page.length - 1];
      if (last === undefined || page.length < 200) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    return swept;
  }
}
