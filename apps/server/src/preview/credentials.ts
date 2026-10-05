import { randomInt } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';

/**
 * The preview's sign-ins, and the one place they are written (invariant 10, D-381).
 *
 * Passwords are random per run, never logged and never committed: the file is
 * `preview-credentials.local.md` at the repository root by default, which `.gitignore`
 * names, and the seed prints only its path.
 */

/** No 0/O, 1/l/I: the owner reads these off a page and types them by hand. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Four groups of five, about 117 bits: strong, and easy to read aloud. */
export function previewPassword(): string {
  const groups: string[] = [];
  for (let group = 0; group < 4; group += 1) {
    let text = '';
    for (let index = 0; index < 5; index += 1) text += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(text);
  }
  return groups.join('-');
}

export interface PreviewLogin {
  readonly label: string;
  readonly email: string;
  readonly password: string;
  /** Which app this person opens. */
  readonly app: 'console' | 'portal' | 'till';
  /** §6: these enrol an authenticator app at their first sign-in. */
  readonly twoFactor: boolean;
  readonly note: string;
}

export interface PreviewUrls {
  readonly console: string;
  readonly portal: string;
  readonly till: string;
}

/**
 * Where the owner opens each app. Named outright by `PREVIEW_*_URL` (`pnpm preview:local`
 * sets them); otherwise a public API address means the preview server's one-origin layout
 * (D-352: the console at `/`, the portal at `/portal/`, the till at `/pos/`), and anything
 * else the dev servers' ports.
 */
export function previewUrls(env: Record<string, string | undefined> = process.env): PreviewUrls {
  const api = env.API_PUBLIC_URL === undefined ? undefined : new URL(env.API_PUBLIC_URL);
  const local = api === undefined || ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
  const origin = api?.origin ?? '';
  return {
    console: env.PREVIEW_CONSOLE_URL ?? (local ? 'http://localhost:5173' : `${origin}/`),
    portal: env.PREVIEW_PORTAL_URL ?? (local ? 'http://localhost:5174' : `${origin}/portal`),
    till: env.PREVIEW_POS_URL ?? (local ? 'http://localhost:5175' : `${origin}/pos`),
  };
}

/** The file's text. Markdown, so it reads well in any editor. */
export function credentialsMarkdown(
  logins: readonly PreviewLogin[],
  urls: PreviewUrls,
  extras: {
    readonly brand: string;
    /** Whether the training brand was imported, for the super admin's line. */
    readonly training?: boolean;
    readonly tracking?: {
      readonly orderNo: string;
      readonly phoneLast4: string;
      readonly slug: string;
    };
  },
  now: Date = new Date(),
): string {
  const appUrl = (app: PreviewLogin['app']) =>
    app === 'console' ? urls.console : app === 'portal' ? urls.portal : urls.till;
  const rows = logins.map(
    (login) =>
      `| ${login.label} | ${appUrl(login.app)} | \`${login.email}\` | \`${login.password}\` | ${login.twoFactor ? 'Yes, on first sign-in' : 'No'} | ${login.note} |`,
  );
  return [
    '# ERP preview: sign-ins',
    '',
    `Made by \`pnpm preview:seed\` on ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    'Keep this file private. It is never committed (it is in `.gitignore`).',
    'Running the seed again changes every password below; a two-step login set up already stays.',
    '',
    `Everyone works in the brand **${extras.brand}**. The super admin also sees the other four brands` +
      (extras.training === true ? ' and the training brand.' : '.'),
    'The investor portal and the tracking page open in Bangla; the language button at the top switches to English.',
    '',
    '| Who | Open | Email | Password | Two-step login | Good for |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Two-step login',
    '',
    'People marked "Yes" are asked to set up two-step login the first time they sign in.',
    'Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator',
    'or similar), choose "add account", then "enter a setup key", and type the key the screen',
    'shows. Tick "I have saved my recovery codes", type the 6-digit code from the app, and',
    'confirm. Next time, the app gives you a new code each time you sign in.',
    '',
    '## Order tracking',
    '',
    extras.tracking === undefined
      ? "Open any shipped order in the console, then track it on the portal with its order number and the last 4 digits of the buyer's phone."
      : `Open ${urls.portal}/track/${extras.tracking.slug} and type order number \`${extras.tracking.orderNo}\` and phone digits \`${extras.tracking.phoneLast4}\` (a made-up demo buyer).`,
    '',
  ].join('\n');
}

export function writeCredentials(file: string, text: string): void {
  // `mode` applies only when the file is created, so a file from an earlier run is made
  // owner-only first, before the new passwords are in it. (Windows ignores both.)
  if (existsSync(file)) chmodSync(file, 0o600);
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
}
