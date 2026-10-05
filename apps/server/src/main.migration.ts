import 'reflect-metadata';

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NestFactory } from '@nestjs/core';
import { withGlobal } from '@elysium/db';
import { maskPhonesInText, takaParts, type ImportProblem, type Poisha } from '@elysium/domain';
import { isMigrationKind, type OpeningPosition } from '@elysium/domain/migration';
import { sql } from 'drizzle-orm';

import { runDemo } from './modules/migration/demo.js';
import {
  LegacyCustomersImporter,
  LegacyCustomersModule,
  LegacyImportError,
  type LegacyImportReport,
} from './modules/storefront/legacy-customers.js';
import { MigrationError } from './modules/migration/migration.errors.js';
import { MigrationModule } from './modules/migration/migration.module.js';
import {
  MigrationService,
  type ImportReport,
  type MigrationActor,
  type ReconciliationReport,
} from './modules/migration/migration.service.js';

/**
 * `pnpm migration` — a brand's data migration, run by the implementation team (M14a, D-214).
 *
 *   pnpm migration dry-run   --org <slug> --kind <kind> --file <path.csv>
 *   pnpm migration commit    --org <slug> --kind <kind> --file <path.csv>
 *   pnpm migration discard   --org <slug> --batch <id>
 *   pnpm migration status    --org <slug>
 *   pnpm migration post      --org <slug> --as-of <YYYY-MM-DD> --approved-by "<accountant>"
 *   pnpm migration reconcile --org <slug> [--out <report.csv>]
 *   pnpm migration sign-off  --org <slug> --by "<accountant>" [--note "<text>"]
 *   pnpm migration legacy-customers --org <slug> dry-run|commit --file <users.json>   (M34)
 *   pnpm demo:org
 *
 * Kinds, in the order a brand runs them: skus, customers, opening_stock,
 * supplier_balances, wallet_balances, courier_cod.
 *
 * Boots `MigrationModule` as an application context — no HTTP, the way the worker boots
 * its modules — against `DATABASE_URL`, so every write runs as `erp_app` inside the org's
 * row-level security. `demo` also seeds the training org's set-up, which needs
 * `DATABASE_OWNER_URL` like `pnpm db:seed`. Build the server first.
 *
 * Output goes to stdout as plain text. A customers report carries counts only, never a
 * phone or a name (invariant 10).
 */

const ACTOR = 'system:migration';

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function required(args: readonly string[], name: string): string {
  const value = argument(args, name);
  if (value === undefined || value.startsWith('--')) {
    throw new MigrationError('MIGRATION_IMPORT_REJECTED', `--${name} is required.`);
  }
  return value;
}

/**
 * A path as the operator typed it. `pnpm migration` runs in `apps/server`, so a relative
 * path is resolved against the directory the command was typed in (`INIT_CWD`).
 */
function fromCaller(file: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
}

function print(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** Exact taka text from poisha: no rounding, because there is nothing to round. */
function taka(amount: Poisha | bigint): string {
  const parts = takaParts(amount as Poisha);
  const whole = parts.taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${parts.negative ? '-' : ''}${whole}.${parts.poisha.toString().padStart(2, '0')}`;
}

function money(text: string | number | undefined): string {
  return typeof text === 'string' && /^-?\d+$/.test(text) ? taka(BigInt(text)) : String(text);
}

async function orgBySlug(slug: string): Promise<string> {
  const rows = await withGlobal((tx) =>
    tx.execute<{ id: string }>(sql`select id from org.organizations where slug = ${slug}`),
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new MigrationError('MIGRATION_NOT_FOUND', `No brand "${slug}".`);
  return id;
}

function printProblems(problems: readonly ImportProblem[]): void {
  if (problems.length === 0) return;
  print(`Problems (${String(problems.length)}) — nothing is written while any remain:`);
  for (const problem of problems.slice(0, 200)) {
    print(
      `  line ${String(problem.line)}${problem.column === null ? '' : ` [${problem.column}]`}: ${problem.message}`,
    );
  }
  if (problems.length > 200) print(`  … and ${String(problems.length - 200)} more.`);
}

function printPosition(title: string, position: OpeningPosition): void {
  print(title);
  if (position.lines.length === 0) {
    print('  (nothing staged)');
    return;
  }
  print(
    `  ${'section'.padEnd(20)} ${'account / party'.padEnd(24)} ${'debit'.padStart(16)} ${'credit'.padStart(16)}`,
  );
  for (const line of position.lines) {
    print(
      `  ${line.section.padEnd(20)} ${line.label.slice(0, 24).padEnd(24)} ${taka(line.debitPoisha).padStart(16)} ${taka(line.creditPoisha).padStart(16)}`,
    );
  }
  print(
    `  ${'total'.padEnd(45)} ${taka(position.totalDebitPoisha).padStart(16)} ${taka(position.totalCreditPoisha).padStart(16)}`,
  );
  print(`  Balanced: ${position.balanced ? 'yes' : 'NO'}`);
  print(
    `  Stock: ${String(position.units)} units, valued Σ(qty × cost) = ${taka(position.stockValuePoisha)}`,
  );
}

function printReport(report: ImportReport): void {
  print(`${report.kind} — ${report.fileName} (sha256 ${report.contentSha256.slice(0, 12)}…)`);
  if (report.alreadyImported !== null) {
    print(
      `  Already imported as ${report.alreadyImported.batchId} (${report.alreadyImported.status}).`,
    );
  }
  print(
    `  Rows to write: ${String(report.rows)}; left alone (already there): ${String(report.skipped)}`,
  );
  for (const [key, value] of Object.entries(report.summary)) {
    print(`  ${key}: ${key.endsWith('Poisha') ? money(value) : String(value)}`);
  }
  printProblems(report.problems);
  print(
    `  Can commit: ${report.canCommit ? 'yes' : 'no'}${report.reason === null ? '' : ` — ${report.reason}`}`,
  );
  if (report.position !== null) {
    printPosition('Opening trial balance (this file and everything staged):', report.position);
  }
}

function reconciliationCsv(report: ReconciliationReport): string {
  const rows = [
    ['section', 'party', 'imported_taka', 'journal_taka', 'module_taka', 'agrees'],
    ...report.rows.map((row) => [
      row.section,
      row.label,
      taka(row.importedPoisha).replace(/,/g, ''),
      taka(row.journalPoisha).replace(/,/g, ''),
      taka(row.modulePoisha).replace(/,/g, ''),
      row.agrees ? 'yes' : 'NO',
    ]),
    [],
    ['journal_debit_taka', taka(report.journalDebitPoisha).replace(/,/g, '')],
    ['journal_credit_taka', taka(report.journalCreditPoisha).replace(/,/g, '')],
    ['opening_date', report.asOf],
    ['agrees', report.agrees ? 'yes' : 'NO'],
    ['signed_off_by', report.signedOffBy ?? ''],
  ];
  return `${rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')).join('\n')}\n`;
}

function printReconciliation(report: ReconciliationReport): void {
  print(`Reconciliation — opening dated ${report.asOf}, journal ${report.journalId}`);
  print(
    `  ${'section'.padEnd(20)} ${'party'.padEnd(20)} ${'imported'.padStart(16)} ${'journal'.padStart(16)} ${'module'.padStart(16)}  agrees`,
  );
  for (const row of report.rows) {
    print(
      `  ${row.section.padEnd(20)} ${row.label.slice(0, 20).padEnd(20)} ${taka(row.importedPoisha).padStart(16)} ${taka(row.journalPoisha).padStart(16)} ${taka(row.modulePoisha).padStart(16)}  ${row.agrees ? 'yes' : 'NO'}`,
    );
  }
  print(
    `  Journal: debit ${taka(report.journalDebitPoisha)}, credit ${taka(report.journalCreditPoisha)} — trial balance ${report.journalBalanced ? 'zero' : 'NOT ZERO'}`,
  );
  print(`  Every line agrees: ${report.agrees ? 'yes' : 'NO'}`);
  print(
    report.signedOffBy === null
      ? '  Not signed off. The accountant signs with `pnpm migration sign-off`.'
      : `  Signed off by ${report.signedOffBy} at ${report.signedOffAt ?? ''}.`,
  );
}

function printLegacy(report: LegacyImportReport): void {
  const { counts } = report.plan;
  print(`Old website customers — ${String(counts.rows)} rows`);
  print(
    `  Website accounts: ${String(counts.accounts)} (${String(counts.accountsWithPassword)} with their password, ${String(counts.googleOnly)} without one, ${String(counts.verified)} verified)`,
  );
  print(`  Buyers by phone: ${String(counts.buyers)}`);
  print(
    `  Left out: ${String(counts.staff)} staff, ${String(counts.duplicates)} duplicate emails, ${String(counts.alreadyImported)} already here, ${String(counts.invalid)} with no email or phone`,
  );
  const notes = [...report.plan.skipped, ...report.plan.warnings].sort((a, b) => a.row - b.row);
  for (const note of notes.slice(0, 200)) print(`  row ${String(note.row)}: ${note.reason}`);
  if (notes.length > 200) print(`  … and ${String(notes.length - 200)} more.`);
  print(
    report.written === null
      ? '  Dry run: nothing was written.'
      : `  Committed: ${String(report.written.accounts)} accounts and ${String(report.written.buyers)} buyers.`,
  );
}

/** `pnpm migration legacy-customers --org <slug> dry-run|commit --file <users.json>` (M34, D-531). */
async function legacyCustomers(args: readonly string[]): Promise<void> {
  const mode = args.includes('commit') ? 'commit' : args.includes('dry-run') ? 'dry-run' : null;
  if (mode === null) {
    throw new MigrationError('MIGRATION_IMPORT_REJECTED', 'Say dry-run or commit.');
  }
  const orgId = await orgBySlug(required(args, 'org'));
  const text = await readFile(fromCaller(required(args, 'file')), 'utf8');
  const context = await NestFactory.createApplicationContext(LegacyCustomersModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const importer = context.get(LegacyCustomersImporter);
    printLegacy(
      mode === 'commit' ? await importer.commit(orgId, text) : await importer.dryRun(orgId, text),
    );
  } catch (error) {
    if (error instanceof LegacyImportError) {
      throw new MigrationError('MIGRATION_IMPORT_REJECTED', error.message);
    }
    throw error;
  } finally {
    await context.close();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === 'legacy-customers') {
    await legacyCustomers(args);
    return;
  }
  const context = await NestFactory.createApplicationContext(MigrationModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const service = context.get(MigrationService);

    if (command === 'demo') {
      const result = await runDemo(service);
      print(`Training org ${result.orgId}`);
      for (const file of result.imported) {
        print(`  ${file.kind.padEnd(18)} ${file.created ? 'imported' : 'already imported'}`);
      }
      print(
        `  Opening ${result.opening.created ? 'posted' : 'already posted'} as of ${result.opening.asOf}`,
      );
      printReconciliation(result.reconciliation);
      return;
    }

    const actor: MigrationActor = { orgId: await orgBySlug(required(args, 'org')), userId: ACTOR };
    const file = async () => {
      const kind = required(args, 'kind');
      if (!isMigrationKind(kind)) {
        throw new MigrationError('MIGRATION_IMPORT_REJECTED', `"${kind}" is not an importer.`);
      }
      const filePath = fromCaller(required(args, 'file'));
      return { kind, fileName: path.basename(filePath), csv: await readFile(filePath, 'utf8') };
    };

    switch (command ?? '') {
      case 'dry-run':
        printReport(await service.dryRun(actor, await file()));
        return;
      case 'commit': {
        const input = await file();
        const report = await service.dryRun(actor, input);
        printReport(report);
        const result = await service.commit(actor, input);
        print(
          result.created
            ? `Committed as ${result.batchId} (${result.status}): ${String(result.rows)} rows.`
            : `Already imported as ${result.batchId} (${result.status}); nothing was written.`,
        );
        return;
      }
      case 'discard':
        await service.discard(actor, required(args, 'batch'));
        print('Discarded. Import the corrected file.');
        return;
      case 'status': {
        const status = await service.status(actor);
        for (const batch of status.batches) {
          print(
            `  ${batch.id}  ${batch.kind.padEnd(18)} ${batch.status.padEnd(10)} ${String(batch.rowCount).padStart(6)} rows  ${batch.fileName}`,
          );
        }
        print(
          status.opening === null
            ? 'Books not opened yet.'
            : `Books opened as of ${status.opening.as_of} (journal ${status.opening.journal_id}).`,
        );
        if (status.opening === null) printPosition('Staged opening trial balance:', status.staged);
        return;
      }
      case 'post': {
        const opening = await service.postOpening(actor, {
          asOf: required(args, 'as-of'),
          approvedBy: required(args, 'approved-by'),
        });
        print(
          opening.created
            ? `Opening posted as of ${opening.asOf}: journal ${opening.journalId}, ${String(opening.movements)} stock movements.`
            : `The books were already opened as of ${opening.asOf}; nothing was written.`,
        );
        printPosition('Opening trial balance:', opening.position);
        return;
      }
      case 'reconcile': {
        const report = await service.reconciliation(actor);
        printReconciliation(report);
        const out = argument(args, 'out');
        if (out !== undefined) {
          await writeFile(fromCaller(out), reconciliationCsv(report), 'utf8');
          print(`Written to ${fromCaller(out)}.`);
        }
        return;
      }
      case 'sign-off': {
        const note = argument(args, 'note');
        const report = await service.signOff(actor, {
          by: required(args, 'by'),
          ...(note === undefined ? {} : { note }),
        });
        printReconciliation(report);
        return;
      }
      default:
        throw new MigrationError(
          'MIGRATION_IMPORT_REJECTED',
          'Commands: dry-run, commit, discard, status, post, reconcile, sign-off, demo.',
        );
    }
  } finally {
    await context.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof MigrationError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    for (const problem of error.problems.slice(0, 200)) {
      process.stderr.write(
        `  line ${String(problem.line)}${problem.column === null ? '' : ` [${problem.column}]`}: ${problem.message}\n`,
      );
    }
  } else {
    // A driver error can quote a row — a unique violation names the phone it collided on —
    // so the text is masked before it reaches a terminal (invariant 10).
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${maskPhonesInText(text)}\n`);
  }
  process.exitCode = 1;
}
// The connection pools hold the event loop open; the command is done, so it ends here.
process.exit();
