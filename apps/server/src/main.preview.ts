import 'reflect-metadata';

import { existsSync } from 'node:fs';
import path from 'node:path';

import { seedGeography, seedOrganizations } from '@elysium/db';
import { maskPhonesInText, poisha, takaParts } from '@elysium/domain';

import { runDemo, sampleDirectory } from './modules/migration/demo.js';
import { MigrationService } from './modules/migration/migration.service.js';
import { createLogger } from './platform/logging/logger.js';
import { PreviewCallError } from './preview/client.js';
import {
  credentialsMarkdown,
  previewUrls,
  writeCredentials,
  type PreviewLogin,
} from './preview/credentials.js';
import { assertPreviewTarget } from './preview/guard.js';
import { People, PREVIEW_EMAIL_DOMAIN } from './preview/people.js';
import { startPreviewRuntime } from './preview/runtime.js';
import {
  checkBooks,
  Context,
  prepareScenario,
  previewBrand,
  runScenario,
} from './preview/scenario.js';

/**
 * `pnpm preview:seed` — make a database previewable by hand (D-380).
 *
 *   pnpm preview:seed [--brand <slug>] [--out <file> | --out -] [--allow-existing-users]
 *
 * One command, idempotent, needing only the server's usual environment
 * (`DATABASE_URL`, `DATABASE_OWNER_URL`, `AUTH_SECRET`, …), so it runs on a developer's PC
 * and inside the server image alike. Build the server first. It:
 *
 * 1. runs `pnpm db:seed`'s steps and the training brand's import (`pnpm demo:org`); with
 *    `--brand <slug>` (or `ERP_BRAND_SLUG`) only that brand is seeded and demoed, the way
 *    a brand's own ERP is previewed (D-470);
 * 2. boots the application in this process and creates one login per role through the
 *    real invite flow (`preview/people.ts`);
 * 3. creates a few weeks' worth of a brand's work through the real routes
 *    (`preview/scenario.ts`) — never by writing into a module's tables;
 * 4. checks the books of every brand it wrote to (`checkBooks`) and fails on a difference;
 * 5. writes the sign-ins to `preview-credentials.local.md` (gitignored), and prints only
 *    the file's path. `--out -` writes the file to stdout instead, with progress on stderr:
 *    inside the server image the application directory is read-only, so the operator
 *    redirects it to a file of their own (docs/runbooks/preview-kit.md).
 *
 * The training brand is imported from `apps/server/migration-sample/`. An image that does
 * not ship those files skips it, says so, and checks one brand's books instead of two.
 *
 * Guarded (D-381, `preview/guard.ts`): it writes only to a database marked as a preview,
 * reached by the same database through both of its connections, where nobody outside the
 * preview can sign in. The SMS and Meta gateways are forced to their fakes in this process.
 */

/** Progress goes to stdout, or to stderr when stdout carries the credentials file. */
let progress: NodeJS.WriteStream = process.stdout;

function print(text = ''): void {
  progress.write(`${text}\n`);
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

/** Taka with lakh grouping and the poisha, for the books line: a difference may be small. */
function taka(amount: string): string {
  const parts = takaParts(poisha(amount));
  const text = parts.taka.toString();
  const last3 = text.slice(-3);
  const rest = text.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const whole = rest === '' ? last3 : `${rest},${last3}`;
  const fraction = parts.poisha === 0n ? '' : `.${parts.poisha.toString().padStart(2, '0')}`;
  return `${parts.negative ? '-' : ''}Tk ${whole}${fraction}`;
}

/**
 * Everything that could reach the outside world, pinned to its stand-in for this process:
 * demo phone numbers are valid Bangladeshi numbers, and an SMS gateway enabled on the
 * server must not text them.
 */
const FAKE_GATEWAYS = {
  NOTIFY_SMS_PROVIDER: 'fake',
  NOTIFY_BULKSMSBD_ENABLED: 'false',
  MARKETING_META_PROVIDER: 'fake',
  MARKETING_META_ENABLED: 'false',
} as const;

async function main(args: readonly string[]): Promise<void> {
  // The seed's own output is the readable summary below; the application's logs are kept
  // to warnings unless asked for.
  process.env.LOG_LEVEL = process.env.PREVIEW_LOG_LEVEL ?? 'warn';
  Object.assign(process.env, FAKE_GATEWAYS);
  if ((process.env.COURIER_CREDENTIALS_KEY ?? '') === '') {
    throw new Error(
      'preview:seed needs COURIER_CREDENTIALS_KEY: the demo courier gets a webhook secret, ' +
        'which is stored encrypted (`openssl rand -base64 32`).',
    );
  }
  const requested =
    argument(args, 'out') ?? process.env.PREVIEW_CREDENTIALS_FILE ?? 'preview-credentials.local.md';
  const toStdout = requested === '-';
  if (toStdout) {
    progress = process.stderr;
    // stdout is the credentials file now; a log line must not land in it.
    process.env.LOG_DESTINATION = 'stderr';
  }
  const out = toStdout ? '-' : path.resolve(process.env.INIT_CWD ?? process.cwd(), requested);

  print('preview:seed');
  const database = await assertPreviewTarget({
    emailDomain: PREVIEW_EMAIL_DOMAIN,
    allowExistingUsers: args.includes('--allow-existing-users'),
  });
  print(`  database: ${database} (marked as a preview)`);

  // One brand, as a brand's own ERP has (D-470), or all five, as before.
  const onlyBrand = argument(args, 'brand') ?? process.env.ERP_BRAND_SLUG;
  const brand = previewBrand(onlyBrand === '' ? undefined : onlyBrand);
  const geography = await seedGeography();
  const seeded = await seedOrganizations(
    onlyBrand === undefined || onlyBrand === '' ? {} : { brands: [brand.slug] },
  );
  print(
    `  base seed: ${String(seeded.organizations)} brands, ${String(geography.thanas)} thanas, ` +
      `${String(seeded.accounts)} ledger accounts`,
  );

  const logger = createLogger('preview');
  const runtime = await startPreviewRuntime(logger);
  let retire: () => Promise<unknown> = () => Promise.resolve();
  try {
    const samples = existsSync(sampleDirectory());
    const demo = samples ? await runDemo(runtime.app.get(MigrationService)) : undefined;
    print(
      demo === undefined
        ? '  training brand: skipped, this build has no migration-sample files'
        : `  training brand: ${String(demo.imported.filter((file) => file.created).length)} file(s) imported, ` +
            `books ${demo.reconciliation.journalBalanced ? 'balanced' : 'NOT BALANCED'}`,
    );

    const orgId = brand.orgId;
    const people = new People(runtime, orgId);
    retire = () => people.retireRobots();
    await people.retireRobots();
    const ctx = new Context(runtime, people, orgId, brand.slug);
    const branchIds = await prepareScenario(ctx);
    await people.ensureLogins({ branchIds });
    print(`  ${String(people.credentials().length)} logins ready, with new passwords`);

    print(`  demo activity in ${brand.name}:`);
    await runScenario(ctx, print);

    const books = await checkBooks(people, ctx.today(), { training: demo !== undefined, brand });
    let unbalanced = demo !== undefined && !demo.reconciliation.journalBalanced;
    for (const check of books) {
      unbalanced ||= !check.ok;
      const shown = Object.entries(check.figures)
        .map(([name, value]) =>
          name === 'couriers' || name === 'disagreeing'
            ? `${name} ${value}`
            : `${name} ${taka(value)}`,
        )
        .join(', ');
      print(
        `  books, ${check.brand}, ${check.label}: ${shown} — ${check.ok ? 'agree' : 'DISAGREE'}`,
      );
    }

    const logins: PreviewLogin[] = people.credentials().map(({ spec, password }) => ({
      label: spec.label,
      email: spec.email,
      password,
      app: spec.app,
      twoFactor: spec.twoFactor,
      note: spec.note,
    }));
    const text = credentialsMarkdown(logins, previewUrls(), {
      brand: brand.name,
      training: demo !== undefined,
      ...(ctx.summary.trackingOrder === undefined ? {} : { tracking: ctx.summary.trackingOrder }),
    });
    if (toStdout) process.stdout.write(text);
    else writeCredentials(out, text);

    const counts = Object.entries(ctx.summary.counts)
      .map(([key, value]) => `${String(value)} ${key}`)
      .join(', ');
    if (counts !== '') print(`  created: ${counts}`);
    for (const note of ctx.summary.notes) print(`  note: ${maskPhonesInText(note)}`);
    // The path, never a password: this output lands in terminals and logs.
    print(toStdout ? '  sign-ins written to stdout' : `  sign-ins written to ${out}`);

    if (unbalanced) {
      throw new Error('the books disagree after seeding (above); this is a bug, not a preview.');
    }
    print('preview:seed done.');
  } finally {
    // The seed's own hands are put down whether the run finished or not.
    await retire();
    await runtime.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const text =
    error instanceof PreviewCallError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  // A refusal can quote a row, and a row can carry a phone number (invariant 10).
  process.stderr.write(`preview:seed failed: ${maskPhonesInText(text)}\n`);
  process.exitCode = 1;
}
// The pools and the jobs runtime hold the event loop open; the command is done.
process.exit();
