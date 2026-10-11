import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  maskEmail,
  renderEmail,
  type EmailTemplateKey,
  type RenderedEmail,
} from '@elysium/domain/notify';
import { normaliseEmail } from '@elysium/domain/storefront';

import { enqueue } from '../../platform/jobs/enqueue.js';
import {
  open,
  seal,
  SealedBoxUnavailable,
  sealedBoxConfigured,
} from '../../platform/crypto/sealed-box.js';
import { NOTIFY_CONFIG, type NotifyConfig } from './notify.config.js';
import { NotifyError } from './notify.errors.js';
import { NOTIFY_SEND_EMAIL_QUEUE } from './notify.queues.js';
import * as repo from './emails.repository.js';
import { isTrainingOrg } from './notify.repository.js';
import { MAILER, type MailResult, type Mailer, type SmtpSettings } from './providers/mailer.js';

/** How many times one email is tried before it is recorded as failed for good. */
export const EMAIL_MAX_ATTEMPTS = 3;

export interface QueueEmailInput {
  readonly templateKey: EmailTemplateKey;
  readonly to: string;
  readonly values: Readonly<Record<string, string>>;
  readonly refType?: string | null;
  readonly refId?: string | null;
  /** One email per key, however often the caller asks (an order's status email, D-530). */
  readonly dedupeKey?: string | null;
}

export type QueuedEmail =
  | { readonly emailId: string; readonly state: 'queued' }
  | { readonly emailId: string; readonly state: 'skipped'; readonly reason: string }
  | { readonly emailId: string; readonly state: 'duplicate' };

export interface EmailSettingsView {
  /** STOREFRONT_CREDENTIALS_KEY is set, so a password can be kept at all. */
  readonly keyConfigured: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string;
  readonly hasPassword: boolean;
  readonly passwordFingerprint: string | null;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly updatedAt: string | null;
}

const BODY_FIELD = 'body';
const PASSWORD_FIELD = 'password';

function bodyBinding(orgId: string, emailId: string) {
  return { orgId, row: `notify.emails:${emailId}`, field: BODY_FIELD };
}

function passwordBinding(orgId: string) {
  return { orgId, row: 'notify.email_settings', field: PASSWORD_FIELD };
}

/**
 * The email channel (M34, D-529): the website's codes, password links and order news.
 *
 * Three rules, as the SMS channel has them:
 *
 * - **Written in the caller's transaction, sent by a job** with no transaction open
 *   (invariant 6): a code and the email carrying it commit together, and the send happens in
 *   the worker. A brand with no email server set up (or switched off) gets its emails written
 *   as `skipped`, so the log can say why a shopper heard nothing.
 * - **Nothing reusable stays readable.** The rendered body is sealed until it is sent and then
 *   cleared; a code's email is a one-time code in a sealed column for at most the minutes it
 *   takes to send.
 * - **Addresses are masked in every log line** (invariant 10).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(NOTIFY_CONFIG) private readonly config: NotifyConfig,
  ) {}

  async queue(tx: Tx, orgId: string, input: QueueEmailInput): Promise<QueuedEmail> {
    const to = normaliseEmail(input.to);
    if (to === null) {
      throw new NotifyError('VALIDATION_FAILED', 'That is not an email address.');
    }
    const rendered = renderEmail(input.templateKey, input.values);
    const id = randomUUID();

    let skipped: string | null = null;
    const settings = await repo.emailSettings(tx, orgId);
    if (await isTrainingOrg(tx, orgId)) skipped = 'training';
    else if (settings?.enabled !== true) skipped = 'not_configured';

    let bodySealed: Buffer | null = null;
    if (skipped === null) {
      try {
        bodySealed = seal(
          JSON.stringify({ text: rendered.text, html: rendered.html }),
          bodyBinding(orgId, id),
        ).ciphertext;
      } catch (error) {
        if (!(error instanceof SealedBoxUnavailable)) throw error;
        skipped = 'no_key';
      }
    }

    const written = await repo.insertEmail(tx, {
      id,
      orgId,
      templateKey: input.templateKey,
      // Every email is English (D-750); the column stays until one migration retires it.
      locale: 'en',
      toEmail: to,
      subject: rendered.subject,
      bodySealed,
      state: skipped === null ? 'queued' : 'skipped',
      error: skipped,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      dedupeKey: input.dedupeKey ?? null,
    });
    if (!written.created) return { emailId: written.id, state: 'duplicate' };
    if (skipped !== null) return { emailId: written.id, state: 'skipped', reason: skipped };
    await enqueue(
      tx,
      NOTIFY_SEND_EMAIL_QUEUE.name,
      { emailId: written.id },
      { orgId, ref: written.id },
    );
    return { emailId: written.id, state: 'queued' };
  }

  /**
   * Send one queued email: the `notify.send_email` job's whole body. Read in one
   * transaction, sent with none open, recorded in a third. Idempotent: an email already sent or
   * failed is left alone. Throws only for a failure worth retrying, so pg-boss tries again.
   */
  async deliver(orgId: string, emailId: string): Promise<'sent' | 'failed' | 'skipped'> {
    const actor = { orgId, userId: 'system:notify' };
    const due = await withOrg(actor, async (tx) => {
      const email = await repo.emailById(tx, orgId, emailId);
      if (email?.state !== 'queued' || email.body_sealed === null) return null;
      const settings = await repo.emailSettings(tx, orgId);
      return { email, settings };
    });
    if (due === null) return 'skipped';

    const { email, settings } = due;
    let message: { text: string; html: string };
    let smtp: SmtpSettings;
    try {
      if (settings?.enabled !== true) throw new SealedBoxUnavailable('not_configured');
      message = JSON.parse(open(email.body_sealed!, bodyBinding(orgId, emailId))) as {
        text: string;
        html: string;
      };
      smtp = this.smtpOf(orgId, settings);
    } catch (error) {
      if (!(error instanceof SealedBoxUnavailable) && !(error instanceof SyntaxError)) throw error;
      // The server was switched off, or the key changed since the email was queued: nothing
      // to try again with, so it ends here and says why.
      await withOrg(actor, (tx) =>
        repo.recordEmailOutcome(tx, orgId, emailId, {
          state: 'failed',
          error: settings?.enabled === true ? 'unreadable' : 'not_configured',
        }),
      );
      return 'failed';
    }

    const result = await this.mailer.send(
      smtp,
      { to: email.to_email, subject: email.subject, text: message.text, html: message.html },
      { timeoutMs: this.config.NOTIFY_EMAIL_TIMEOUT_MS },
    );

    const last = email.attempts + 1 >= EMAIL_MAX_ATTEMPTS;
    await withOrg(actor, (tx) =>
      repo.recordEmailOutcome(
        tx,
        orgId,
        emailId,
        result.ok
          ? { state: 'sent', providerMessageId: result.providerMessageId }
          : result.retryable && !last
            ? { state: 'retry', error: result.error }
            : { state: 'failed', error: result.error },
      ),
    );
    if (result.ok) return 'sent';
    this.logger.warn(
      `Email to ${maskEmail(email.to_email)} failed through ${this.mailer.name}: ${result.error}`,
    );
    if (result.retryable && !last) {
      throw new Error(`notify.send_email: ${result.error}, will retry`);
    }
    return 'failed';
  }

  async settingsView(tx: Tx, orgId: string): Promise<EmailSettingsView> {
    const row = await repo.emailSettings(tx, orgId);
    return {
      keyConfigured: sealedBoxConfigured(),
      configured: row !== undefined,
      enabled: row?.enabled ?? false,
      host: row?.host ?? '',
      port: row?.port ?? 587,
      secure: row?.secure ?? false,
      username: row?.username ?? '',
      hasPassword: row?.password_sealed != null,
      passwordFingerprint: row?.fingerprint ?? null,
      fromName: row?.from_name ?? '',
      fromEmail: row?.from_email ?? '',
      updatedAt: row === undefined ? null : new Date(row.updated_at).toISOString(),
    };
  }

  /** Save the brand's server (the password sealed, or kept when none is sent). */
  async saveSettings(
    tx: Tx,
    orgId: string,
    input: {
      readonly enabled: boolean;
      readonly host: string;
      readonly port: number;
      readonly secure: boolean;
      readonly username: string;
      readonly password?: string | undefined;
      readonly fromName: string;
      readonly fromEmail: string;
    },
    userId: string,
  ): Promise<void> {
    const fromEmail = normaliseEmail(input.fromEmail);
    if (fromEmail === null) {
      throw new NotifyError('VALIDATION_FAILED', 'The sender is not an email address.');
    }
    const sealed =
      input.password === undefined ? undefined : seal(input.password, passwordBinding(orgId));
    const existing = await repo.emailSettings(tx, orgId);
    if (
      input.enabled &&
      input.username !== '' &&
      sealed === undefined &&
      existing?.password_sealed == null
    ) {
      throw new NotifyError(
        'VALIDATION_FAILED',
        'Give the email server’s password before switching it on.',
      );
    }
    await repo.upsertEmailSettings(tx, {
      orgId,
      enabled: input.enabled,
      host: input.host,
      port: input.port,
      secure: input.secure,
      username: input.username,
      ...(sealed === undefined
        ? {}
        : {
            password: {
              sealed: sealed.ciphertext,
              keyId: sealed.keyId,
              fingerprint: sealed.fingerprint,
            },
          }),
      fromName: input.fromName,
      fromEmail,
      updatedBy: userId,
    });
  }

  /**
   * A test email through the saved server, now, with no transaction open (the settings are
   * read in their own): the console's "Send a test" answers with what the server said.
   */
  async sendTest(orgId: string, to: string, brand: string): Promise<MailResult> {
    const address = normaliseEmail(to);
    if (address === null) {
      throw new NotifyError('VALIDATION_FAILED', 'That is not an email address.');
    }
    const settings = await withOrg({ orgId, userId: 'system:notify' }, (tx) =>
      repo.emailSettings(tx, orgId),
    );
    if (settings === undefined) return { ok: false, error: 'not_configured', retryable: false };
    let smtp: SmtpSettings;
    try {
      smtp = this.smtpOf(orgId, settings);
    } catch (error) {
      if (error instanceof SealedBoxUnavailable) {
        return { ok: false, error: 'unreadable', retryable: false };
      }
      throw error;
    }
    const rendered: RenderedEmail = renderEmail('smtp.test', { brand });
    const result = await this.mailer.send(
      smtp,
      { to: address, ...rendered },
      { timeoutMs: this.config.NOTIFY_EMAIL_TIMEOUT_MS },
    );
    if (!result.ok) {
      this.logger.warn(`Test email to ${maskEmail(address)} failed: ${result.error}`);
    }
    return result;
  }

  async recent(tx: Tx, orgId: string, limit: number) {
    const rows = await repo.listEmails(tx, orgId, limit);
    return rows.map((row) => ({
      id: row.id,
      templateKey: row.template_key,
      locale: row.locale,
      to: row.to_email,
      subject: row.subject,
      state: row.state,
      attempts: row.attempts,
      error: row.error,
      sentAt: row.sent_at === null ? null : new Date(row.sent_at).toISOString(),
      refType: row.ref_type,
      refId: row.ref_id,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  private smtpOf(orgId: string, row: repo.EmailSettingsRow): SmtpSettings {
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password:
        row.password_sealed === null ? null : open(row.password_sealed, passwordBinding(orgId)),
      fromName: row.from_name,
      fromEmail: row.from_email,
    };
  }
}
