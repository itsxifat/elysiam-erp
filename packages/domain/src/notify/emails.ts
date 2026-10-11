/**
 * The website's emails (M34, D-529): one-time codes, password resets and order news, in
 * English (D-750: the brands never wanted Bangla, so there is one copy of each).
 *
 * Templates are code, not rows: each needs a particular set of values and a link shape the
 * website serves, and a template a person could edit is one that could drop the code out of a
 * verification email. The brand's name is a value like any other (white label: no template
 * names a brand). Every value is HTML-escaped into the HTML part and left as-is in the text
 * part; links are built by the caller from the brand's own site address.
 */

export const EMAIL_TEMPLATE_KEYS = [
  'account.email_code',
  'account.password_reset',
  'order.placed',
  'order.confirmed',
  'order.shipped',
  'order.delivered',
  'order.cancelled',
  'smtp.test',
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export function isEmailTemplateKey(value: string): value is EmailTemplateKey {
  return (EMAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export class EmailTemplateError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`The email is missing ${missing.join(', ')}.`);
    this.name = 'EmailTemplateError';
  }
}

type Values = Readonly<Record<string, string>>;

interface Copy {
  readonly subject: (v: Values) => string;
  /** Paragraphs, each a plain sentence; `{name}` style is not used, functions are. */
  readonly lines: (v: Values) => readonly string[];
  /** A prominent value (the code), shown on its own. */
  readonly highlight?: (v: Values) => string;
  /** A button: label and the value key holding the URL. */
  readonly action?: { readonly label: (v: Values) => string; readonly urlKey: string };
}

const REQUIRED: Readonly<Record<EmailTemplateKey, readonly string[]>> = {
  'account.email_code': ['brand', 'name', 'code'],
  'account.password_reset': ['brand', 'name', 'resetUrl'],
  'order.placed': ['brand', 'name', 'orderNo', 'total', 'orderUrl'],
  'order.confirmed': ['brand', 'name', 'orderNo', 'orderUrl'],
  'order.shipped': ['brand', 'name', 'orderNo', 'orderUrl', 'courier', 'trackingCode'],
  'order.delivered': ['brand', 'name', 'orderNo', 'orderUrl'],
  'order.cancelled': ['brand', 'name', 'orderNo', 'orderUrl'],
  'smtp.test': ['brand'],
};

const v = (values: Values, key: string): string => values[key] ?? '';

const COPY: Readonly<Record<EmailTemplateKey, Copy>> = {
  'account.email_code': {
    subject: (x) => `Your ${v(x, 'brand')} verification code`,
    lines: (x) => [
      `Dear ${v(x, 'name')},`,
      'Use this code to verify your email address. It works for 15 minutes.',
      'If you did not ask for it, you can ignore this email.',
    ],
    highlight: (x) => v(x, 'code'),
  },
  'account.password_reset': {
    subject: (x) => `Reset your ${v(x, 'brand')} password`,
    lines: (x) => [
      `Dear ${v(x, 'name')},`,
      'Someone asked to reset the password of your account. The link works for one hour.',
      'If it was not you, ignore this email; your password stays as it is.',
    ],
    action: { label: () => 'Reset password', urlKey: 'resetUrl' },
  },
  'order.placed': {
    subject: (x) => `Order ${v(x, 'orderNo')} received — ${v(x, 'brand')}`,
    lines: (x) => [
      `Dear ${v(x, 'name')},`,
      `Thank you. We have received your order ${v(x, 'orderNo')} for ${v(x, 'total')}.`,
      'We will call you to confirm it before it is sent.',
    ],
    action: { label: () => 'View your order', urlKey: 'orderUrl' },
  },
  'order.confirmed': {
    subject: (x) => `Order ${v(x, 'orderNo')} confirmed — ${v(x, 'brand')}`,
    lines: (x) => [
      `Dear ${v(x, 'name')},`,
      `Your order ${v(x, 'orderNo')} is confirmed and is being prepared.`,
    ],
    action: { label: () => 'View your order', urlKey: 'orderUrl' },
  },
  'order.shipped': {
    subject: (x) => `Order ${v(x, 'orderNo')} is on its way — ${v(x, 'brand')}`,
    lines: (x) => [
      `Dear ${v(x, 'name')},`,
      `Your order ${v(x, 'orderNo')} has been handed to ${v(x, 'courier')}.`,
      v(x, 'trackingCode') === '' ? '' : `Tracking code: ${v(x, 'trackingCode')}`,
    ],
    action: { label: () => 'Track your order', urlKey: 'orderUrl' },
  },
  'order.delivered': {
    subject: (x) => `Order ${v(x, 'orderNo')} delivered — ${v(x, 'brand')}`,
    lines: (x) => [
      `Dear ${v(x, 'name')},`,
      `Your order ${v(x, 'orderNo')} has been delivered. Thank you for shopping with us.`,
    ],
    action: { label: () => 'View your order', urlKey: 'orderUrl' },
  },
  'order.cancelled': {
    subject: (x) => `Order ${v(x, 'orderNo')} cancelled — ${v(x, 'brand')}`,
    lines: (x) => [
      `Dear ${v(x, 'name')},`,
      `Your order ${v(x, 'orderNo')} has been cancelled.`,
      'If you paid online, the refund is arranged with you separately.',
    ],
    action: { label: () => 'View your order', urlKey: 'orderUrl' },
  },
  'smtp.test': {
    subject: (x) => `Test email from ${v(x, 'brand')}`,
    lines: () => ['This is a test. The email settings work.'],
  },
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only `https://` links go into an email's button; anything else is left out. */
function safeLink(url: string): string | null {
  return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

/**
 * One email, in English (D-750). Throws `EmailTemplateError` naming any missing value, so a
 * template change and its caller cannot drift into a blank code or a dead link.
 */
export function renderEmail(key: EmailTemplateKey, values: Values): RenderedEmail {
  const missing = REQUIRED[key].filter((name) => values[name] === undefined);
  if (missing.length > 0) throw new EmailTemplateError(missing);
  // A header is one line: no value may break the subject across two.
  const clean: Values = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, value.replace(/[\r\n]+/g, ' ').trim()]),
  );
  const copy = COPY[key];
  const subject = copy.subject(clean).slice(0, 200);
  const lines = copy.lines(clean).filter((line) => line !== '');
  const highlight = copy.highlight?.(clean) ?? null;
  const link = copy.action === undefined ? null : safeLink(clean[copy.action.urlKey] ?? '');
  const label = copy.action?.label(clean) ?? '';

  const text = [
    ...lines,
    ...(highlight === null ? [] : ['', highlight, '']),
    ...(link === null ? [] : [`${label}: ${link}`]),
    '',
    v(clean, 'brand'),
  ].join('\n');

  const paragraphs = lines
    .map(
      (line) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${escapeHtml(line)}</p>`,
    )
    .join('');
  const code =
    highlight === null
      ? ''
      : `<p style="margin:20px 0;font-size:28px;font-weight:600;letter-spacing:6px;font-family:monospace">${escapeHtml(highlight)}</p>`;
  const button =
    link === null
      ? ''
      : `<p style="margin:20px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border:1px solid #222;color:#222;text-decoration:none;border-radius:6px">${escapeHtml(label)}</a></p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px;background:#ffffff;color:#222;font-family:system-ui,sans-serif"><div style="max-width:520px;margin:0 auto"><p style="margin:0 0 20px;font-size:13px;letter-spacing:2px;text-transform:uppercase">${escapeHtml(v(clean, 'brand'))}</p>${paragraphs}${code}${button}</div></body></html>`;

  return { subject, text, html };
}

/**
 * An address for a log line: the first letter of the mailbox and the domain's last label, the
 * rest starred (`r***@g***.com`). Invariant 10: an address is personal data like a phone.
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot < 0 ? '' : domain.slice(dot);
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}
