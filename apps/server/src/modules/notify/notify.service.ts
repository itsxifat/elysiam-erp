import { Inject, Injectable, Logger } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { isFreeOfBangla, maskPhone, normalizeBdPhone } from '@elysium/domain';
import {
  inQuietHours,
  nextSendTime,
  renderTemplate,
  TemplateError,
  type MessageCategory,
} from '@elysium/domain/notify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { NOTIFY_CONFIG, type NotifyConfig } from './notify.config.js';
import { NotifyError } from './notify.errors.js';
import { NOTIFY_SEND_QUEUE } from './notify.queues.js';
import * as repo from './notify.repository.js';
import type { UpsertTemplateInput } from './notify.schemas.js';
import { SMS_GATEWAY, type SmsGateway } from './providers/sms-gateway.js';

/** `+8801711000999`, `01711000999` or `8801711000999` — always `01711000999` here. */
function national(phone: string): string {
  const e164 = normalizeBdPhone(phone);
  return `0${e164.slice(4)}`;
}

/**
 * Notifications: what a buyer is told, when, and the record that they were (M16, §10).
 *
 * Three rules, each with a test against real Postgres:
 *
 * - **Quiet hours, 21:00–09:00 Asia/Dhaka, for everything but an OTP** (check 4). Applied
 *   when a message is queued — the send job does not exist to the worker until 09:00 —
 *   and checked again when it runs, because a queue that was down overnight delivers its
 *   backlog in a burst that can land back inside the window.
 * - **An opt-out suppresses everything but an OTP.** Suppressed messages are still
 *   written, as `suppressed`, so the log can answer "did we tell this buyer?" with "no,
 *   and here is why" rather than with silence.
 * - **The gateway is called with no transaction open** (invariant 6). The message is
 *   read in one transaction, sent with none, and its outcome recorded in a third.
 *
 * Phones are the address and are stored, in the tenant's own table; they never reach a
 * log unmasked (invariant 10) and never leave in an event payload.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    @Inject(SMS_GATEWAY) private readonly gateway: SmsGateway,
    @Inject(NOTIFY_CONFIG) private readonly config: NotifyConfig,
    private readonly audit: AuditService,
  ) {}

  /**
   * Write a message and schedule its send, inside the caller's transaction.
   *
   * The caller's transaction rather than one of this module's own: an occasion code and
   * the message announcing it commit together, so a buyer is never told about a code that
   * was rolled back, and never given one nobody told them about.
   */
  async queue(
    tx: Tx,
    orgId: string,
    input: {
      readonly templateKey: string;
      readonly phone: string;
      readonly values: Readonly<Record<string, string>>;
      readonly refType?: string | null;
      readonly refId?: string | null;
      /**
       * The kind of message the caller is sending. The template must be that kind: the
       * category decides whether opt-outs and quiet hours apply, so it is the caller's to
       * state, not a template editor's to change underneath it.
       */
      readonly category?: MessageCategory;
      /** When the message is due. Now, unless a caller is backdating a test. */
      readonly now?: Date;
    },
  ): Promise<{
    readonly messageId: string;
    readonly state: 'queued' | 'suppressed';
    readonly sendAfter: Date;
  }> {
    const template = await repo.templateByKey(tx, orgId, input.templateKey, 'sms');
    if (!template?.is_active) {
      throw new NotifyError(
        'NOTIFY_TEMPLATE_INVALID',
        `This brand has no active SMS template called ${input.templateKey}.`,
      );
    }

    if (input.category !== undefined && template.category !== input.category) {
      throw new NotifyError(
        'NOTIFY_TEMPLATE_INVALID',
        `${input.templateKey} is a ${template.category} template; this message is ${input.category}.`,
      );
    }

    // English, always (D-750): `body_en` is the one body. `body_bn` stays in the table only
    // until one migration drops it once the parallel branches have merged (D-755). A body saved
    // before the save-time check, with Bangla in it, is refused here rather than texted.
    if (!isFreeOfBangla(template.body_en)) {
      throw new NotifyError(
        'NOTIFY_TEMPLATE_INVALID',
        `${input.templateKey} is not written in English; rewrite it before it is sent.`,
      );
    }
    let body: string;
    try {
      body = renderTemplate(template.body_en, input.values);
    } catch (error) {
      if (error instanceof TemplateError) {
        throw new NotifyError('NOTIFY_TEMPLATE_INVALID', error.message);
      }
      throw error;
    }

    const phone = national(input.phone);
    const category = template.category as MessageCategory;
    const now = input.now ?? new Date();

    // An OTP is how a person signs in; an opt-out from offers must never lock them out.
    // The training org sends nothing at all: its buyers' demo numbers are a real mobile
    // range, so a trainee practising templates would otherwise text strangers (D-223).
    const suppressed =
      (await repo.isTrainingOrg(tx, orgId)) ||
      (category !== 'otp' && (await repo.isOptedOut(tx, orgId, phone, template.channel)));
    const sendAfter = nextSendTime(now, category);

    const messageId = await repo.insertMessage(tx, {
      orgId,
      templateKey: template.key,
      channel: template.channel,
      category,
      phone,
      locale: 'en',
      body,
      state: suppressed ? 'suppressed' : 'queued',
      sendAfter,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
    });

    if (!suppressed) {
      await enqueue(tx, NOTIFY_SEND_QUEUE.name, { messageId }, { orgId, startAfter: sendAfter });
    }
    return { messageId, state: suppressed ? 'suppressed' : 'queued', sendAfter };
  }

  /**
   * Send one queued message. The `notify.send` job's whole body.
   *
   * Idempotent: a message already sent or suppressed is left alone, and a redelivered job
   * after a crash finds it sent. Throws only for a failure worth retrying, which is what
   * makes pg-boss try again; a refusal the gateway names is recorded and not retried.
   */
  async deliver(
    orgId: string,
    messageId: string,
    now: Date = new Date(),
  ): Promise<'sent' | 'failed' | 'deferred' | 'suppressed' | 'skipped'> {
    const actor = { orgId, userId: 'system:notify' };

    // 1. Read it, and decide whether this is the moment, in a transaction of its own.
    const due = await withOrg(actor, async (tx) => {
      const message = await repo.messageById(tx, orgId, messageId);
      if (message === undefined || !['queued', 'failed'].includes(message.state)) return null;

      // The buyer may have opted out between the queueing and now — an offer queued at
      // 22:00 for 09:00 waits eleven hours. Checked again here, as quiet hours are. And
      // nothing leaves the training org (D-223), whenever the message was queued.
      if (
        (await repo.isTrainingOrg(tx, orgId)) ||
        (message.category !== 'otp' && (await repo.isOptedOut(tx, orgId, message.phone, 'sms')))
      ) {
        await repo.suppressMessage(tx, orgId, messageId);
        return 'suppressed' as const;
      }

      if (message.category !== 'otp' && inQuietHours(now)) {
        const later = nextSendTime(now, message.category as MessageCategory);
        await repo.deferMessage(tx, orgId, messageId, later);
        await enqueue(tx, NOTIFY_SEND_QUEUE.name, { messageId }, { orgId, startAfter: later });
        return 'deferred' as const;
      }
      return message;
    });
    if (due === null) return 'skipped';
    if (due === 'deferred' || due === 'suppressed') return due;

    // 2. The gateway, with no transaction open (invariant 6).
    const result = await this.gateway.send(due.phone, due.body, {
      timeoutMs: this.config.NOTIFY_SMS_TIMEOUT_MS,
    });

    // 3. What it said, in a third.
    await withOrg(actor, (tx) =>
      repo.recordOutcome(
        tx,
        orgId,
        messageId,
        result.ok
          ? {
              state: 'sent',
              provider: this.gateway.name,
              providerMessageId: result.providerMessageId,
            }
          : { state: 'failed', provider: this.gateway.name, error: result.error },
      ),
    );

    if (result.ok) return 'sent';
    // The phone masked and the code, never the provider's prose (invariant 10).
    this.logger.warn(
      `SMS to ${maskPhone(due.phone)} failed through ${this.gateway.name}: ${result.error}`,
    );
    if (result.retryable) {
      throw new Error(`notify.send: ${this.gateway.name} ${result.error}, will retry`);
    }
    return 'failed';
  }

  async listTemplates(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listTemplates(tx, context.orgId)).map((row) => ({
        id: row.id,
        key: row.key,
        channel: row.channel,
        category: row.category,
        bodyEn: row.body_en,
        isActive: row.is_active,
      })),
    }));
  }

  async upsertTemplate(
    context: ActiveContext,
    request: AuditableRequest,
    input: UpsertTemplateInput,
  ) {
    // Rendered once with every placeholder filled, so a template that cannot render — a
    // stray `{` — is refused when it is saved rather than when a buyer is due a message.
    try {
      renderTemplate(input.bodyEn, new Proxy({}, { get: () => 'x' }));
    } catch (error) {
      if (error instanceof TemplateError)
        throw new NotifyError('NOTIFY_TEMPLATE_INVALID', error.message);
      throw error;
    }
    // Every SMS is English (D-750): a template written in Bangla is refused when it is saved,
    // not discovered on a buyer's phone.
    if (!isFreeOfBangla(input.bodyEn)) {
      throw new NotifyError(
        'NOTIFY_TEMPLATE_INVALID',
        'Write the message in English: every SMS is sent in English.',
      );
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const existing = await repo.templateByKey(tx, context.orgId, input.key, 'sms');
      if (existing?.category === 'otp') {
        throw new NotifyError(
          'NOTIFY_TEMPLATE_INVALID',
          `${input.key} is a sign-in code template, which only the system changes.`,
        );
      }
      const saved = await repo.upsertTemplate(tx, {
        orgId: context.orgId,
        key: input.key,
        channel: 'sms',
        category: input.category,
        bodyEn: input.bodyEn,
        isActive: input.isActive ?? true,
        updatedBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'notify.template.saved',
        entityType: 'NotifyTemplate',
        entityId: saved.id,
        before: null,
        after: { key: saved.key, category: saved.category, isActive: saved.is_active },
        requestId: context.requestId,
        request,
      });
      return { id: saved.id, key: saved.key, category: saved.category, isActive: saved.is_active };
    });
  }

  async listOptOuts(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listOptOuts(tx, context.orgId, 500)).map((row) => ({
        id: row.id,
        phone: row.phone,
        channel: row.channel,
        reason: row.reason,
        createdAt: row.created_at,
      })),
    }));
  }

  async addOptOut(
    context: ActiveContext,
    request: AuditableRequest,
    input: { readonly phone: string; readonly reason?: string | undefined },
  ) {
    const phone = national(input.phone);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const { id, created } = await repo.addOptOut(tx, {
        orgId: context.orgId,
        phone,
        channel: 'sms',
        reason: input.reason ?? null,
        createdBy: context.userId,
      });
      if (created) {
        // Keyed on the row, not the number: `entityId` is stored as given in an append-only
        // table, while `after.phone` goes through the audit redactor's phone mask.
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'notify.opt_out.added',
          entityType: 'NotifyOptOut',
          entityId: id,
          before: null,
          after: { phone, channel: 'sms' },
          requestId: context.requestId,
          request,
        });
      }
      return { phone, channel: 'sms' };
    });
  }

  async removeOptOut(context: ActiveContext, request: AuditableRequest, rawPhone: string) {
    const phone = national(rawPhone);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const removedId = await repo.removeOptOut(tx, context.orgId, phone, 'sms');
      if (removedId !== null) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'notify.opt_out.removed',
          entityType: 'NotifyOptOut',
          entityId: removedId,
          before: { phone, channel: 'sms' },
          after: null,
          requestId: context.requestId,
          request,
        });
      }
      return { removed: removedId !== null };
    });
  }

  async listMessages(
    context: ActiveContext,
    filters: { state?: string | undefined; limit: number },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listMessages(tx, context.orgId, filters)).map((row) => ({
        id: row.id,
        templateKey: row.template_key,
        category: row.category,
        phone: row.phone,
        locale: row.locale,
        body: row.body,
        state: row.state,
        sendAfter: row.send_after,
        attempts: row.attempts,
        provider: row.provider,
        error: row.error,
        sentAt: row.sent_at,
        refType: row.ref_type,
        refId: row.ref_id,
        createdAt: row.created_at,
      })),
    }));
  }
}
