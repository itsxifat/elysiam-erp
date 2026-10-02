import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { seedTrainingOrg } from '@elysium/db';
import { businessDate, parseCsv } from '@elysium/domain';
import { anonymizeTable, toCsv, type MigrationKind } from '@elysium/domain/migration';

import type { MigrationService, PostedOpening, ReconciliationReport } from './migration.service.js';

/**
 * The training org, seeded from anonymised data (M14a, D-223).
 *
 * Seeds the org's set-up (`seedTrainingOrg`), then runs the repository's sample files
 * through the anonymiser and the **real** importers and opening post — the same path a
 * brand's go-live takes, so a trainee's demo stock and money arrived the way a brand's do.
 *
 * Only the repository's synthetic sample, never a directory of the operator's choosing.
 * The anonymiser protects people — phones, names, consignments — but scales money by a
 * constant written in this codebase, so a real brand's purchase costs and dues run through
 * it would be readable, near enough, by every trainee in the training org.
 *
 * Idempotent: the importers skip a file already imported and the opening posts once, so a
 * second run changes nothing and prints the same reconciliation.
 */

/** The files, in the order a brand imports them, by the name each has in the directory. */
export const SAMPLE_FILES: readonly { readonly kind: MigrationKind; readonly file: string }[] = [
  { kind: 'skus', file: 'skus.csv' },
  { kind: 'customers', file: 'customers.csv' },
  { kind: 'opening_stock', file: 'opening-stock.csv' },
  { kind: 'supplier_balances', file: 'supplier-balances.csv' },
  { kind: 'wallet_balances', file: 'wallet-balances.csv' },
  { kind: 'courier_cod', file: 'courier-cod.csv' },
];

/** The repository's sample files, from either `src/` (tests) or `dist/` (the command). */
export function sampleDirectory(): string {
  return path.resolve(import.meta.dirname, '../../../migration-sample');
}

export interface DemoResult {
  readonly orgId: string;
  readonly imported: readonly { readonly kind: MigrationKind; readonly created: boolean }[];
  readonly opening: PostedOpening;
  readonly reconciliation: ReconciliationReport;
}

export async function runDemo(
  service: MigrationService,
  options: { readonly asOf?: string } = {},
): Promise<DemoResult> {
  const directory = sampleDirectory();
  const orgId = await seedTrainingOrg();
  const actor = { orgId, userId: 'system:migration-demo' };

  const imported: { kind: MigrationKind; created: boolean }[] = [];
  for (const { kind, file } of SAMPLE_FILES) {
    const source = await readFile(path.join(directory, file), 'utf8');
    const csv = toCsv(anonymizeTable(kind, parseCsv(source)));
    const result = await service.commit(actor, { kind, fileName: `demo-${file}`, csv });
    imported.push({ kind, created: result.created });
  }

  // The evening before "go-live", which for a demo is today.
  const asOf = options.asOf ?? businessDate(new Date());
  const opening = await service.postOpening(actor, { asOf, approvedBy: 'Training demo' });
  const reconciliation = await service.reconciliation(actor);
  return { orgId, imported, opening, reconciliation };
}
