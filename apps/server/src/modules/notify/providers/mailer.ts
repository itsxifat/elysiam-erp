import nodemailer from 'nodemailer';

/**
 * Where an email leaves the building (M34, D-529): the brand's own SMTP server, through
 * nodemailer (the old website's mailer).
 *
 * Called with no database transaction open (invariant 6): the send job reads the email in one
 * transaction, sends with none, and records the outcome in another. The server's settings
 * arrive per call, opened from their sealed column just before; nothing keeps a password in a
 * field for the life of the process.
 */

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /** TLS from the first byte (465). Otherwise STARTTLS is required, never plain text. */
  readonly secure: boolean;
  readonly username: string;
  readonly password: string | null;
  readonly fromName: string;
  readonly fromEmail: string;
}

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type MailResult =
  | { readonly ok: true; readonly providerMessageId: string | null }
  | {
      readonly ok: false;
      /** A short code for the log (`smtp_535`, `timeout`, `connection`), never the server's prose. */
      readonly error: string;
      /** A timeout or a 4xx: worth another try. A 5xx refusal or bad credentials: not. */
      readonly retryable: boolean;
    };

export interface Mailer {
  readonly name: string;
  send(
    settings: SmtpSettings,
    email: OutgoingEmail,
    options: { readonly timeoutMs: number },
  ): Promise<MailResult>;
}

export const MAILER = Symbol('Mailer');

/** A display name for a `From:` header: no quotes, no line breaks, no angle brackets. */
function displayName(name: string): string {
  return name.replace(/["<>\r\n\\]/g, ' ').trim();
}

/** What a send failure says, as a token: nodemailer's `responseCode` or its error `code`. */
function failureOf(error: unknown): { error: string; retryable: boolean } {
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    responseCode?: unknown;
    code?: unknown;
  };
  if (typeof record.responseCode === 'number') {
    const code = record.responseCode;
    return { error: `smtp_${String(code)}`, retryable: code >= 400 && code < 500 };
  }
  const code = typeof record.code === 'string' ? record.code : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'EDNS') {
    return { error: code === 'ETIMEDOUT' ? 'timeout' : 'connection', retryable: true };
  }
  if (code === 'EAUTH') return { error: 'auth', retryable: false };
  if (code === 'EENVELOPE') return { error: 'envelope', retryable: false };
  return { error: 'unknown', retryable: true };
}

export class SmtpMailer implements Mailer {
  readonly name = 'smtp';

  async send(
    settings: SmtpSettings,
    email: OutgoingEmail,
    options: { readonly timeoutMs: number },
  ): Promise<MailResult> {
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      // Port 587 and friends: STARTTLS or nothing. A server that does not offer it is not one
      // a shopper's reset link should cross in the clear.
      requireTLS: !settings.secure,
      ...(settings.username === '' || settings.password === null
        ? {}
        : { auth: { user: settings.username, pass: settings.password } }),
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    });
    try {
      const info = await transport.sendMail({
        from: { name: displayName(settings.fromName), address: settings.fromEmail },
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      const id = (info as { messageId?: unknown }).messageId;
      return { ok: true, providerMessageId: typeof id === 'string' ? id.slice(0, 200) : null };
    } catch (error) {
      return { ok: false, ...failureOf(error) };
    } finally {
      transport.close();
    }
  }
}

/** The mailer every test uses: it records instead of sending. */
export class FakeMailer implements Mailer {
  readonly name = 'fake';
  readonly sent: { readonly settings: SmtpSettings; readonly email: OutgoingEmail }[] = [];
  readonly failNext: MailResult[] = [];

  send(settings: SmtpSettings, email: OutgoingEmail): Promise<MailResult> {
    const planned = this.failNext.shift();
    if (planned !== undefined) return Promise.resolve(planned);
    this.sent.push({ settings, email });
    return Promise.resolve({ ok: true, providerMessageId: `fake-${String(this.sent.length)}` });
  }

  clear(): void {
    this.sent.length = 0;
    this.failNext.length = 0;
  }
}
