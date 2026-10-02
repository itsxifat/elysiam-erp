import { BootstrapRefused, bootstrapSuperAdmin, consoleUrlFrom } from './modules/iam/bootstrap.js';

/**
 * `pnpm admin:bootstrap`: the first super admin on a brand-new database (M30).
 *
 *   pnpm admin:bootstrap --email <address> --name "<full name>" [--console-url <url>]
 *
 * Build the server first. It needs `DATABASE_URL` and `DATABASE_OWNER_URL`, the server's
 * usual environment; inside the server image run it as
 * `node dist/main.admin.js bootstrap --email … --name …`.
 *
 * It prints a one-time `/accept-invite#token=…` link, valid 72 hours, and nothing else that
 * is secret. Hand the link to the person over a channel you trust. They choose a password
 * and must enrol two-step verification before anything else (§6). It refuses once any super
 * admin exists, and it never promotes an existing account (`modules/iam/bootstrap.ts`).
 */

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE =
  'usage: pnpm admin:bootstrap --email <address> --name "<full name>" [--console-url <url>]';

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command !== 'bootstrap') throw new BootstrapRefused(USAGE);
  const email = argument(rest, 'email');
  const name = argument(rest, 'name');
  if (email === undefined || name === undefined) throw new BootstrapRefused(USAGE);

  const result = await bootstrapSuperAdmin({
    email,
    name,
    consoleUrl: consoleUrlFrom(argument(rest, 'console-url'), process.env),
  });

  process.stdout.write(
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

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      error instanceof BootstrapRefused
        ? `admin:bootstrap refused: ${message}\n`
        : `admin:bootstrap failed: ${message}\n`,
    );
    process.exit(1);
  },
);
