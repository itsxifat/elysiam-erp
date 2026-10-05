import 'reflect-metadata';

import { BootstrapRefused, bootstrapSuperAdmin, consoleUrlFrom } from './modules/iam/bootstrap.js';
import type { CommandOutput } from './modules/storefront/website-admin.js';

/**
 * The operator's commands on the server. Build the server first. They need the server's usual
 * environment (`DATABASE_URL`, and `DATABASE_OWNER_URL` for `bootstrap`); inside the server
 * image run them as `node dist/main.admin.js <command> …`.
 *
 * `bootstrap`, `pnpm admin:bootstrap` (M30): the first super admin on a brand-new database.
 *
 *   pnpm admin:bootstrap --email <address> --name "<full name>" [--console-url <url>]
 *
 * It prints a one-time `/accept-invite#token=…` link, valid 72 hours, and nothing else that
 * is secret. Hand the link to the person over a channel you trust. They choose a password
 * and must enrol two-step verification before anything else (§6). It refuses once any super
 * admin exists, and it never promotes an existing account (`modules/iam/bootstrap.ts`).
 *
 * `website-key`, `pnpm admin:website-key` (D-582): a storefront site key for the
 * deployment's brand, the one Website → Connection issues, without the secret ever being
 * shown. Stdout is exactly two lines, `ERP_SITE_KEY_ID=pk_…` and `ERP_SITE_SECRET=sk_…`, so
 * it pipes straight into the website's root-only env file:
 *
 *   node dist/main.admin.js website-key --label "<label>" | sudo tee -a <env file> >/dev/null
 *
 * `website-site-url`, `pnpm admin:website-site-url` (D-582): Website → Settings' Site
 * URL, which the emails' links, password-reset links and SSLCommerz's return addresses are
 * built from. An `https://` address. Stdout is the saved address.
 *
 *   node dist/main.admin.js website-site-url --url https://<website>
 *
 * The brand is `ERP_BRAND_SLUG`, else the database's one brand beside the training org; the
 * website commands refuse when that is not exactly one (`modules/storefront/website-admin.ts`).
 * Everything for the operator, and every log line, goes to stderr.
 */

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE = [
  'usage:',
  '  pnpm admin:bootstrap --email <address> --name "<full name>" [--console-url <url>]',
  '  pnpm admin:website-key --label "<label>"',
  '  pnpm admin:website-site-url --url https://<website>',
  'In the server image: node dist/main.admin.js <bootstrap|website-key|website-site-url> …',
].join('\n');

/** Who refused, for the one-line message: `admin:bootstrap`, `admin:website-key`, … */
let commandName = 'admin:bootstrap';

/** A refusal is one sentence for the operator; anything else is a failure. */
const refusals: (abstract new (message: string) => Error)[] = [BootstrapRefused];

async function main(args: readonly string[], io: CommandOutput): Promise<void> {
  const [command, ...rest] = args;

  if (command === 'website-key' || command === 'website-site-url') {
    commandName = `admin:${command}`;
    // Loaded only for these two: they boot the storefront's modules, which `bootstrap`
    // never needed.
    const website = await import('./modules/storefront/website-admin.js');
    refusals.push(website.WebsiteAdminRefused);
    await (command === 'website-key'
      ? website.websiteKeyCommand(argument(rest, 'label'), io)
      : website.websiteSiteUrlCommand(argument(rest, 'url'), io));
    return;
  }

  if (command !== 'bootstrap') {
    commandName = 'admin';
    throw new BootstrapRefused(USAGE);
  }
  const email = argument(rest, 'email');
  const name = argument(rest, 'name');
  if (email === undefined || name === undefined) throw new BootstrapRefused(USAGE);

  const result = await bootstrapSuperAdmin({
    email,
    name,
    consoleUrl: consoleUrlFrom(argument(rest, 'console-url'), process.env),
  });

  io.out(
    [
      `Super admin created: ${result.email} (${result.userId}).`,
      `Recorded in the audit log of ${String(result.auditedOrgs)} brand(s).`,
      '',
      'One-time link: send it to them over a channel you trust. It sets their password,',
      `and it stops working at ${result.expiresAt.toISOString()} or once used:`,
      '',
      `  ${result.link}`,
      '',
      'They enrol two-step verification at first sign-in, then invite everyone else from',
      'the Staff screen.',
      '',
    ].join('\n'),
  );
}

/*
 * Stdout carries a command's result and nothing else: the website commands' output is piped
 * into a file. So log lines go to stderr (read once, when the server's environment is first
 * parsed, which is after this line), and anything else that writes to stdout while a command
 * runs is sent to stderr too. Only `io.out` reaches the real stdout.
 */
process.env.LOG_DESTINATION = 'stderr';
const stdout = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

const io: CommandOutput = {
  out: (text) => {
    stdout(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

main(process.argv.slice(2), io).then(
  // Exit once stdout has taken everything (a pipe on some systems writes asynchronously),
  // and not with success if it could not: a key piped nowhere is a key nobody has.
  () =>
    stdout('', (error) => {
      if (error != null) process.stderr.write(`${commandName} failed: stdout: ${error.message}\n`);
      process.exit(error == null ? 0 : 1);
    }),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      refusals.some((refusal) => error instanceof refusal)
        ? `${commandName} refused: ${message}\n`
        : `${commandName} failed: ${message}\n`,
    );
    process.exit(1);
  },
);
