import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  addDays,
  businessDate,
  CsvError,
  isIsoDate,
  MAX_JOURNAL_LINES,
  parseCsv,
  poisha,
  type CsvTable,
  type ImportProblem,
  type IsoDate,
  type Poisha,
  type PostingAccount,
} from '@elysium/domain';
import {
  canCommit,
  courierCodTotals,
  isStagedKind,
  normalSide,
  openingJournal,
  openingPosition,
  openingStockTotals,
  reconcileOpening,
  reviewCourierCod,
  reviewCustomers,
  reviewOpeningStock,
  reviewSkus,
  reviewSupplierBalances,
  reviewWalletBalances,
  stagedStockConflicts,
  supplierBalanceTotals,
  walletBalanceTotals,
  type CourierCodRow,
  type MigrationKind,
  type OpeningPosition,
  type OpeningSection,
  type OpeningStockRow,
  type Reconciliation,
  type ReconciliationFigure,
  type SupplierBalanceRow,
  type WalletBalanceRow,
} from '@elysium/domain/migration';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { SUPPLY_API, type SupplyApi } from '../supply/supply.api.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import { asMigrationError, MigrationError } from './migration.errors.js';
import * as repo from './migration.repository.js';

/**
 * Data migration and opening balances (M14a; §7, §8; D-213 to D-223).
 *
 * Six importers, each a dry run and an atomic commit, then one posting that opens the
 * brand's books, then the reconciliation an accountant signs. Run once per brand, before
 * go-live, by the implementation team through `pnpm migration` (D-214).
 *
 * ## The shape every method shares
 *
 * One `withOrg` transaction per call, and every refusal is thrown from inside it, so a
 * refused file or a failed posting leaves nothing behind (check 2). The dry run and the
 * commit both call `review`, which runs the pure importer from `@elysium/domain/migration`
 * against what the database holds *now* — the commit does not trust the dry run, because
 * a file valid at 10:02 is not necessarily valid at 10:05 (M06's reasoning).
 *
 * ## Applied and staged (D-215)
 *
 * SKUs and customers are applied on commit, through the catalog's and the orders module's
 * own interfaces. The four balance files are *staged*: the commit records the parsed rows
 * and nothing reaches stock or the ledger until `postOpening` posts every staged file in
 * one transaction — the opening stock movements and the one opening journal (D-213).
 *
 * Every other module is reached through its `*.api.ts` (invariant 12).
 */

/** Who is acting. The command line passes `system:migration` (D-214). */
export interface MigrationActor {
  readonly orgId: string;
  readonly userId: string;
}

export interface ImportFile {
  readonly kind: MigrationKind;
  readonly fileName: string;
  readonly csv: string;
}

/** The opening trial balance, as amounts in poisha. Purchase cost is in it (invariant 5). */
export type PositionView = OpeningPosition;

export interface ImportReport {
  readonly kind: MigrationKind;
  readonly fileName: string;
  readonly contentSha256: string;
  /** Rows the commit would write. */
  readonly rows: number;
  /** Rows left alone because they are already there (an existing SKU code or buyer). */
  readonly skipped: number;
  readonly problems: readonly ImportProblem[];
  readonly canCommit: boolean;
  readonly reason: string | null;
  /** Counts and totals, never a row's contents. */
  readonly summary: Readonly<Record<string, string | number>>;
  /** The same file is already imported: committing it again changes nothing (check 3). */
  readonly alreadyImported: { readonly batchId: string; readonly status: string } | null;
  /** For a balance file: the opening trial balance of this file plus every staged one. */
  readonly position: PositionView | null;
}

export interface CommitResult {
  readonly batchId: string;
  /** False when the same file was already imported and nothing was written. */
  readonly created: boolean;
  readonly status: string;
  readonly rows: number;
  readonly skipped: number;
}

export interface PostedOpening {
  readonly openingId: string;
  readonly journalId: string;
  readonly asOf: string;
  readonly created: boolean;
  readonly position: PositionView;
  readonly movements: number;
}

export interface MigrationStatus {
  readonly batches: readonly {
    readonly id: string;
    readonly kind: string;
    readonly fileName: string;
    readonly status: string;
    readonly rowCount: number;
    readonly createdAt: string;
  }[];
  readonly opening: repo.OpeningRow | null;
  /** The opening trial balance of what is staged now. Empty once the books are open. */
  readonly staged: PositionView;
}

export interface ReconciliationReport extends Reconciliation {
  readonly asOf: string;
  readonly journalId: string;
  readonly signedOffBy: string | null;
  readonly signedOffAt: string | null;
}

/** The staged rows of every balance file, read back from `migration.batches.rows`. */
interface StagedRows {
  readonly stock: OpeningStockRow[];
  readonly suppliers: SupplierBalanceRow[];
  readonly wallets: WalletBalanceRow[];
  readonly couriers: CourierCodRow[];
}

const WALLET_SUBTYPES = ['wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other'] as const;

/** What a review hands the commit: the problems, and how to apply or stage the rows. */
interface Reviewed {
  readonly problems: readonly ImportProblem[];
  readonly rows: number;
  readonly skipped: number;
  readonly summary: Record<string, string | number>;
  /** For a staged kind: the rows to keep. Null for an applied kind. */
  readonly staged: readonly object[] | null;
  readonly position: PositionView | null;
  readonly apply: (tx: Tx, actor: MigrationActor) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** JSON for `rows`: a bigint becomes its decimal string, read back by `poisha()`. */
function jsonSafe(rows: readonly object[]): unknown {
  return JSON.parse(
    JSON.stringify(rows, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );
}

function money(value: Poisha | bigint): string {
  return value.toString();
}

@Injectable()
export class MigrationService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    @Inject(WALLETS_API) private readonly wallets: WalletsApi,
    @Inject(SUPPLY_API) private readonly supply: SupplyApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly audit: AuditService,
  ) {}

  // --- importers ---------------------------------------------------------------------

  /** Check 1: what the commit would do, and the opening trial balance. Changes nothing. */
  async dryRun(actor: MigrationActor, file: ImportFile): Promise<ImportReport> {
    return withOrg(actor, async (tx) => {
      const contentSha256 = sha256(file.csv);
      const existing = await repo.batchByHash(tx, actor.orgId, file.kind, contentSha256);
      if (existing !== undefined) {
        return {
          kind: file.kind,
          fileName: file.fileName,
          contentSha256,
          rows: 0,
          skipped: existing.row_count,
          problems: [],
          canCommit: true,
          reason: 'This file is already imported; committing it again changes nothing.',
          summary: existing.summary as Record<string, string | number>,
          alreadyImported: { batchId: existing.id, status: existing.status },
          position: null,
        };
      }
      const closed = await this.closedReason(tx, actor, file.kind);
      const reviewed = await this.review(tx, actor, file);
      const verdict = canCommit(reviewed, reviewed.rows);
      return {
        kind: file.kind,
        fileName: file.fileName,
        contentSha256,
        rows: reviewed.rows,
        skipped: reviewed.skipped,
        problems: reviewed.problems,
        canCommit: verdict.ok && closed === null,
        reason: closed ?? verdict.reason,
        summary: reviewed.summary,
        alreadyImported: null,
        position: reviewed.position,
      };
    });
  }

  /**
   * Check 2 and 3: the whole file or none of it, and the same file twice is one import.
   *
   * The batch row goes in first, against `(org, kind, content hash)`'s unique index, so a
   * second commit of the same file — sequential or concurrent — finds the first and writes
   * nothing. Then the file is applied (SKUs, customers) or its rows are kept for the
   * opening (the balances). Any problem at all throws, and the transaction takes the batch
   * row and every write before it with it.
   */
  async commit(actor: MigrationActor, file: ImportFile): Promise<CommitResult> {
    try {
      return await withOrg(actor, async (tx) => {
        await repo.lockOrg(tx, actor.orgId);
        const contentSha256 = sha256(file.csv);
        const existing = await repo.batchByHash(tx, actor.orgId, file.kind, contentSha256);
        if (existing !== undefined) return this.replayed(existing);

        const closed = await this.closedReason(tx, actor, file.kind);
        if (closed !== null) throw new MigrationError('MIGRATION_ALREADY_OPENED', closed);

        const reviewed = await this.review(tx, actor, file);
        const verdict = canCommit(reviewed, reviewed.rows);
        if (!verdict.ok) {
          throw new MigrationError(
            'MIGRATION_IMPORT_REJECTED',
            verdict.reason ?? 'That file cannot be imported.',
            reviewed.problems,
          );
        }

        const status = reviewed.staged === null ? 'applied' : 'staged';
        const batchId = await repo.insertBatch(tx, {
          orgId: actor.orgId,
          kind: file.kind,
          contentSha256,
          fileName: file.fileName.slice(0, 200) || 'import.csv',
          rowCount: reviewed.rows,
          rows: reviewed.staged === null ? null : jsonSafe(reviewed.staged),
          summary: reviewed.summary,
          status,
          createdBy: actor.userId,
        });
        if (batchId === undefined) {
          // The same file, committed by someone else while this one was being reviewed.
          const first = await repo.batchByHash(tx, actor.orgId, file.kind, contentSha256);
          if (first === undefined) throw new Error('A conflicting import vanished.');
          return this.replayed(first);
        }

        await reviewed.apply(tx, actor);

        await this.audit.record(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          operation: 'create',
          action: status === 'applied' ? 'migration.file_applied' : 'migration.file_staged',
          entityType: 'migration_batch',
          entityId: batchId,
          after: { kind: file.kind, rows: reviewed.rows, skipped: reviewed.skipped },
        });

        return {
          batchId,
          created: true,
          status,
          rows: reviewed.rows,
          skipped: reviewed.skipped,
        };
      });
    } catch (error) {
      throw asMigrationError(error);
    }
  }

  /** A staged file, set aside so a corrected one can replace it. */
  async discard(actor: MigrationActor, batchId: string): Promise<void> {
    try {
      if (!UUID.test(batchId)) {
        throw new MigrationError('MIGRATION_NOT_FOUND', 'No such imported file in this brand.');
      }
      await withOrg(actor, async (tx) => {
        await repo.lockOrg(tx, actor.orgId);
        const batch = await repo.batchById(tx, actor.orgId, batchId);
        if (batch === undefined) {
          throw new MigrationError('MIGRATION_NOT_FOUND', 'No such imported file in this brand.');
        }
        if (batch.status !== 'staged') {
          throw new MigrationError(
            'MIGRATION_BATCH_IMMUTABLE',
            `That file is ${batch.status}; only a staged file can be discarded.`,
          );
        }
        if (!(await repo.discardBatch(tx, actor.orgId, batchId, actor.userId))) {
          throw new MigrationError('MIGRATION_BATCH_IMMUTABLE', 'That file is no longer staged.');
        }
        await this.audit.record(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          operation: 'update',
          action: 'migration.file_discarded',
          entityType: 'migration_batch',
          entityId: batchId,
          before: { status: 'staged' },
          after: { status: 'discarded' },
        });
      });
    } catch (error) {
      throw asMigrationError(error);
    }
  }

  async status(actor: MigrationActor): Promise<MigrationStatus> {
    return withOrg(actor, async (tx) => {
      const [batches, opening, staged] = await Promise.all([
        repo.listBatches(tx, actor.orgId),
        repo.openingOf(tx, actor.orgId),
        this.stagedRows(tx, actor.orgId, 'staged'),
      ]);
      return {
        batches: batches.map((batch) => ({
          id: batch.id,
          kind: batch.kind,
          fileName: batch.file_name,
          status: batch.status,
          rowCount: batch.row_count,
          createdAt: batch.created_at,
        })),
        opening: opening ?? null,
        staged: openingPosition(staged),
      };
    });
  }

  // --- the opening ---------------------------------------------------------------------

  /**
   * Open the brand's books from every staged file, in one transaction (D-213, D-215).
   *
   * The `opening_balance` movements, the one opening journal, the opening row and the
   * batches' `posted` mark commit together or not at all. Idempotent: a brand that is
   * already open gets its opening back and nothing is written.
   *
   * Permanent (D-213): there is no re-opening, so the accountant who agreed the staged
   * trial balance is named here (`approvedBy`) and recorded in the audit row. A mistake
   * found afterwards is corrected through the owning module — a stock count or approved
   * adjustment, a wallet closing — not by opening the books again.
   */
  async postOpening(
    actor: MigrationActor,
    input: { readonly asOf: string; readonly approvedBy: string },
  ): Promise<PostedOpening> {
    const approvedBy = input.approvedBy.trim();
    try {
      return await withOrg(actor, async (tx) => {
        await repo.lockOrg(tx, actor.orgId);
        const existing = await repo.openingOf(tx, actor.orgId);
        if (existing !== undefined) {
          const rows = await this.stagedRows(tx, actor.orgId, 'posted');
          return {
            openingId: existing.id,
            journalId: existing.journal_id,
            asOf: existing.as_of,
            created: false,
            position: openingPosition(rows),
            movements: 0,
          };
        }

        const asOf = this.openingDate(input.asOf);
        if (approvedBy === '' || approvedBy.length > 120) {
          throw new MigrationError(
            'MIGRATION_IMPORT_REJECTED',
            'Name the accountant who agreed the staged trial balance; the opening is permanent.',
          );
        }
        const batches = await repo.batchesWithStatus(tx, actor.orgId, 'staged');
        const staged = this.rowsOf(batches);
        if (
          staged.stock.length +
            staged.suppliers.length +
            staged.wallets.length +
            staged.couriers.length ===
          0
        ) {
          throw new MigrationError(
            'MIGRATION_IMPORT_REJECTED',
            'Nothing is staged. Commit the balance files first.',
          );
        }

        // D-216, again at the last moment: a SKU that received stock since its file was
        // staged would blend the opening cost into an average, and the journal and the
        // valuation would no longer agree to the poisha.
        const held = await this.inventory.heldSkus(
          tx,
          actor.orgId,
          staged.stock.map((row) => row.skuId),
        );
        if (held.size > 0) {
          const codes = staged.stock.filter((row) => held.has(row.skuId)).map((r) => r.skuCode);
          throw new MigrationError(
            'MIGRATION_IMPORT_REJECTED',
            `${[...new Set(codes)].join(', ')} received stock after the opening file was staged. Discard that file and import it again.`,
          );
        }

        const conflicts = stagedStockConflicts(staged.stock);
        if (conflicts.length > 0) {
          throw new MigrationError(
            'MIGRATION_IMPORT_REJECTED',
            `${conflicts.join(', ')} are staged at two costs or twice at one location. Discard one of the stock files.`,
          );
        }

        const position = openingPosition(staged);
        const accounts = await this.openingAccounts(tx, actor.orgId, staged.wallets);
        const openingId = randomUUID();

        const occurredAt = this.openingInstant(asOf);
        const received = await this.inventory.receiveOpening(tx, actor, {
          openingId,
          occurredAt,
          lines: staged.stock.map((row) => ({
            skuId: row.skuId,
            locationId: row.locationId,
            qty: row.qty,
            unitCostPoisha: row.unitCostPoisha,
          })),
        });
        // What the movements wrote, against what the journal will debit: a line the
        // movement dedupe swallowed would otherwise be debited to inventory and never
        // reach the shelf.
        if (
          received.movementIds.length !== staged.stock.length ||
          received.valuePoisha !== position.stockValuePoisha
        ) {
          throw new MigrationError(
            'MIGRATION_IMPORT_REJECTED',
            'The stock received and the opening position disagree. Nothing was posted.',
          );
        }

        const draft = openingJournal(position, { orgId: actor.orgId, asOf, accounts });
        const posted = await this.ledger.post(tx, actor, draft);
        if (!posted.created) {
          // The org's key was already posted, with no opening row beside it: something
          // outside this module opened the books. Refused rather than adopted.
          throw new MigrationError(
            'MIGRATION_ALREADY_OPENED',
            'An opening journal already exists for this brand. Nothing was posted.',
          );
        }

        await repo.insertOpening(tx, {
          id: openingId,
          orgId: actor.orgId,
          asOf,
          journalId: posted.journalId,
          postedBy: actor.userId,
        });
        const marked = await repo.markPosted(
          tx,
          actor.orgId,
          batches.map((batch) => batch.id),
          openingId,
          actor.userId,
        );
        if (marked !== batches.length) {
          throw new MigrationError(
            'MIGRATION_BATCH_IMMUTABLE',
            'A staged file changed while the opening was posted. Nothing was posted.',
          );
        }

        await this.audit.record(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          operation: 'create',
          action: 'migration.opening_posted',
          entityType: 'migration_opening',
          entityId: openingId,
          after: {
            asOf,
            approvedBy,
            journalId: posted.journalId,
            movements: received.movementIds.length,
            lines: draft.lines.length,
          },
        });

        return {
          openingId,
          journalId: posted.journalId,
          asOf,
          created: true,
          position,
          movements: received.movementIds.length,
        };
      });
    } catch (error) {
      throw asMigrationError(error);
    }
  }

  /**
   * Check 4 and 5: the opening journal read back, beside the files and the modules.
   *
   * Imported is what the posted files said; journal is what the opening journal carries,
   * read back from the ledger; module is the inventory module's own valuation and each
   * wallet's, supplier's and courier's ledger balance as of the opening date.
   */
  async reconciliation(actor: MigrationActor): Promise<ReconciliationReport> {
    return withOrg(actor, (tx) => this.reconcile(tx, actor.orgId));
  }

  /**
   * Record the accountant's sign-off, once, and only on a reconciliation that agrees.
   *
   * The signature is a person's (M14a check 5 is a human check); this is the system's
   * record that it happened, so M14b's go-live checklist can ask whether it did.
   */
  async signOff(
    actor: MigrationActor,
    input: { readonly by: string; readonly note?: string | null },
  ): Promise<ReconciliationReport> {
    const by = input.by.trim();
    if (by === '' || by.length > 120) {
      throw new MigrationError('MIGRATION_IMPORT_REJECTED', 'Name the accountant signing off.');
    }
    const trimmed = input.note?.trim() ?? '';
    const note = trimmed === '' ? null : trimmed;
    if (note !== null && note.length > 500) {
      throw new MigrationError(
        'MIGRATION_IMPORT_REJECTED',
        'A sign-off note is 500 characters at most.',
      );
    }
    try {
      return await withOrg(actor, async (tx) => {
        await repo.lockOrg(tx, actor.orgId);
        const report = await this.reconcile(tx, actor.orgId);
        if (report.signedOffAt !== null) {
          throw new MigrationError(
            'MIGRATION_OPENING_IMMUTABLE',
            `The reconciliation was already signed off by ${report.signedOffBy ?? ''}.`,
          );
        }
        if (!report.agrees) {
          throw new MigrationError(
            'MIGRATION_NOT_RECONCILED',
            'The reconciliation does not agree on every line; it cannot be signed off.',
          );
        }
        if (!(await repo.signOff(tx, actor.orgId, by, note))) {
          throw new MigrationError(
            'MIGRATION_OPENING_IMMUTABLE',
            'The reconciliation was already signed off.',
          );
        }
        const opening = await repo.openingOf(tx, actor.orgId);
        await this.audit.record(tx, {
          orgId: actor.orgId,
          actorUserId: actor.userId,
          operation: 'approve',
          action: 'migration.reconciliation_signed_off',
          entityType: 'migration_opening',
          entityId: opening?.id ?? '',
          after: { signedOffBy: by },
        });
        return {
          ...report,
          signedOffBy: opening?.signed_off_by ?? by,
          signedOffAt: opening?.signed_off_at ?? null,
        };
      });
    } catch (error) {
      throw asMigrationError(error);
    }
  }

  // --- internals -----------------------------------------------------------------------

  private replayed(batch: repo.BatchRow): CommitResult {
    return {
      batchId: batch.id,
      created: false,
      status: batch.status,
      rows: 0,
      skipped: batch.row_count,
    };
  }

  /** Why a file of this kind cannot be committed now, or null. */
  private async closedReason(
    tx: Tx,
    actor: MigrationActor,
    kind: MigrationKind,
  ): Promise<string | null> {
    if (!isStagedKind(kind)) return null;
    const opening = await repo.openingOf(tx, actor.orgId);
    return opening === undefined
      ? null
      : `This brand's books were opened on ${opening.as_of}. Balance files are closed; a correction is a journal.`;
  }

  /** Parse and review one file against what the database holds now. */
  private async review(tx: Tx, actor: MigrationActor, file: ImportFile): Promise<Reviewed> {
    let table: CsvTable;
    try {
      table = parseCsv(file.csv);
    } catch (error) {
      if (!(error instanceof CsvError)) throw error;
      return {
        problems: [{ line: error.line, column: null, message: error.message }],
        rows: 0,
        skipped: 0,
        summary: {},
        staged: null,
        position: null,
        apply: () => Promise.resolve(),
      };
    }

    switch (file.kind) {
      case 'skus':
        return this.reviewSkus(tx, actor, table);
      case 'customers':
        return this.reviewCustomers(tx, actor, table);
      case 'opening_stock':
      case 'supplier_balances':
      case 'wallet_balances':
      case 'courier_cod':
        return this.reviewBalances(tx, actor, file.kind, table);
    }
  }

  private async reviewSkus(tx: Tx, actor: MigrationActor, table: CsvTable): Promise<Reviewed> {
    const review = reviewSkus(table, await this.catalog.importRefs(tx, actor.orgId));
    return {
      problems: review.problems,
      rows: review.skuCount,
      skipped: review.skipped.length,
      summary: {
        products: review.products.length,
        skus: review.skuCount,
        skipped: review.skipped.length,
      },
      staged: null,
      position: null,
      apply: async (inner, who) => {
        await this.catalog.importProducts(inner, who, review.products);
      },
    };
  }

  private async reviewCustomers(tx: Tx, actor: MigrationActor, table: CsvTable): Promise<Reviewed> {
    // Two passes, because the existing buyers are only known once the phones are read.
    const first = reviewCustomers(table, { existingPhones: new Set() });
    const existingPhones = await this.orders.buyerPhones(
      tx,
      actor.orgId,
      first.rows.map((row) => row.phoneE164),
    );
    const review = reviewCustomers(table, { existingPhones });
    return {
      problems: review.problems,
      rows: review.rows.length,
      skipped: review.skipped.length,
      summary: {
        buyers: review.rows.length,
        skipped: review.skipped.length,
        delivered: review.rows.reduce((n, row) => n + row.delivered, 0),
        returned: review.rows.reduce((n, row) => n + row.returned, 0),
        cancelled: review.rows.reduce((n, row) => n + row.cancelled, 0),
      },
      staged: null,
      position: null,
      apply: async (inner, who) => {
        await this.orders.importBuyers(inner, who, review.rows);
      },
    };
  }

  private async reviewBalances(
    tx: Tx,
    actor: MigrationActor,
    kind: 'opening_stock' | 'supplier_balances' | 'wallet_balances' | 'courier_cod',
    table: CsvTable,
  ): Promise<Reviewed> {
    const staged = await this.stagedRows(tx, actor.orgId, 'staged');
    const column = (name: string) =>
      table.rows.map((row) => (row.values[name] ?? '').trim()).filter((text) => text !== '');

    let rows: readonly object[];
    let problems: readonly ImportProblem[];
    let summary: Record<string, string | number>;
    let next: StagedRows;

    switch (kind) {
      case 'opening_stock': {
        const codes = column('sku').map((code) => code.toUpperCase());
        const skuIds = await this.catalog.skusByCodes(tx, actor.orgId, codes);
        const held = await this.inventory.heldSkus(tx, actor.orgId, [...skuIds.values()]);
        const locations = await repo.locationsByCodes(tx, actor.orgId, column('location'));
        const review = reviewOpeningStock(table, {
          skus: new Map(
            [...skuIds].map(([code, id]) => [code, { id, held: held.has(id) }] as const),
          ),
          locations: new Map(locations.map((row) => [row.code, { id: row.id }] as const)),
          staged: staged.stock,
        });
        const totals = openingStockTotals(review.rows);
        ({ rows, problems } = review);
        summary = {
          rows: totals.rows,
          units: totals.units,
          stockValuePoisha: money(totals.stockValuePoisha),
        };
        next = { ...staged, stock: [...staged.stock, ...review.rows] };
        break;
      }
      case 'supplier_balances': {
        const suppliers = await this.supply.suppliersByCodes(
          tx,
          actor.orgId,
          column('supplier').map((code) => code.toUpperCase()),
        );
        const review = reviewSupplierBalances(table, {
          suppliers: new Map([...suppliers].map(([code, row]) => [code, { id: row.id }] as const)),
          staged: staged.suppliers,
        });
        const totals = supplierBalanceTotals(review.rows);
        ({ rows, problems } = review);
        summary = {
          rows: totals.rows,
          payablePoisha: money(totals.payablePoisha),
          advancePoisha: money(totals.advancePoisha),
        };
        next = { ...staged, suppliers: [...staged.suppliers, ...review.rows] };
        break;
      }
      case 'wallet_balances': {
        const wallets = await this.wallets.walletsByAccountCodes(
          tx,
          actor.orgId,
          column('wallet').map((code) => code.toUpperCase()),
        );
        const review = reviewWalletBalances(table, {
          wallets: new Map(
            [...wallets].map(([code, row]) => [code, { id: row.walletId }] as const),
          ),
          staged: staged.wallets,
        });
        const totals = walletBalanceTotals(review.rows);
        ({ rows, problems } = review);
        summary = { rows: totals.rows, amountPoisha: money(totals.amountPoisha) };
        next = { ...staged, wallets: [...staged.wallets, ...review.rows] };
        break;
      }
      case 'courier_cod': {
        const couriers = await this.orders.couriersByCodes(
          tx,
          actor.orgId,
          column('courier').map((code) => code.toLowerCase()),
        );
        const review = reviewCourierCod(table, {
          couriers: new Map([...couriers].map(([code, row]) => [code, { id: row.id }] as const)),
          staged: staged.couriers,
        });
        const totals = courierCodTotals(review.rows);
        ({ rows, problems } = review);
        summary = { rows: totals.rows, amountPoisha: money(totals.amountPoisha) };
        next = { ...staged, couriers: [...staged.couriers, ...review.rows] };
        break;
      }
    }

    const position = openingPosition(next);
    if (position.lines.length > MAX_JOURNAL_LINES) {
      problems = [
        ...problems,
        {
          line: 1,
          column: null,
          message: `With this file the opening journal would have ${String(position.lines.length)} lines; the ledger takes ${String(MAX_JOURNAL_LINES)}. Combine small balances before importing.`,
        },
      ];
    }

    return {
      problems,
      rows: rows.length,
      skipped: 0,
      summary,
      staged: rows,
      position,
      // Staging is the batch row itself; nothing else is written until the opening.
      apply: () => Promise.resolve(),
    };
  }

  /** Every balance row in batches of one status, parsed back into the domain's shapes. */
  private async stagedRows(
    tx: Tx,
    orgId: string,
    status: 'staged' | 'posted',
  ): Promise<StagedRows> {
    return this.rowsOf(await repo.batchesWithStatus(tx, orgId, status));
  }

  private rowsOf(batches: readonly repo.BatchRow[]): StagedRows {
    const out: StagedRows = { stock: [], suppliers: [], wallets: [], couriers: [] };
    for (const batch of batches) {
      const rows = Array.isArray(batch.rows) ? (batch.rows as Record<string, unknown>[]) : [];
      for (const row of rows) {
        switch (batch.kind) {
          case 'opening_stock':
            out.stock.push({
              ...(row as unknown as OpeningStockRow),
              unitCostPoisha: poisha(String(row.unitCostPoisha)),
            });
            break;
          case 'supplier_balances':
            out.suppliers.push({
              ...(row as unknown as SupplierBalanceRow),
              amountPoisha: poisha(String(row.amountPoisha)),
            });
            break;
          case 'wallet_balances':
            out.wallets.push({
              ...(row as unknown as WalletBalanceRow),
              amountPoisha: poisha(String(row.amountPoisha)),
            });
            break;
          case 'courier_cod':
            out.couriers.push({
              ...(row as unknown as CourierCodRow),
              amountPoisha: poisha(String(row.amountPoisha)),
            });
            break;
        }
      }
    }
    return out;
  }

  /** The chart's system accounts and each staged wallet's own account, or a refusal. */
  private async openingAccounts(tx: Tx, orgId: string, wallets: readonly WalletBalanceRow[]) {
    const system = async (subtype: Parameters<LedgerApi['accountBySubtype']>[2]) => {
      const account = await this.ledger.accountBySubtype(tx, orgId, subtype);
      if (account === null) {
        throw new MigrationError(
          'MIGRATION_IMPORT_REJECTED',
          `This brand's chart has no ${subtype} account. Run the seed for its chart first.`,
        );
      }
      return account;
    };
    const walletAccounts = new Map<string, PostingAccount>();
    for (const row of wallets) {
      const account = await this.wallets.walletAccount(tx, orgId, row.walletId);
      if (account === null) {
        throw new MigrationError(
          'MIGRATION_IMPORT_REJECTED',
          `The wallet ${row.accountCode} was closed after its balance was staged.`,
        );
      }
      walletAccounts.set(row.walletId, account);
    }
    return {
      inventory: await system('inventory'),
      supplierAdvance: await system('supplier_advance'),
      supplierPayable: await system('supplier_payable'),
      courierReceivable: await system('courier_receivable'),
      equity: await system('opening_equity'),
      wallets: walletAccounts,
    };
  }

  /**
   * The opening date: the evening before go-live, today or yesterday in Dhaka (D-221).
   *
   * §7 sends anything older than yesterday through a back-dated approval, and an opening
   * dated in the future would put a brand's stock and money into a day that has not
   * happened. Either is a different decision from opening the books, and is refused.
   */
  private openingDate(text: string): IsoDate {
    if (!isIsoDate(text)) {
      throw new MigrationError('MIGRATION_IMPORT_REJECTED', 'The opening date is YYYY-MM-DD.');
    }
    const today = businessDate(new Date());
    if (text > today || text < addDays(today, -1)) {
      throw new MigrationError(
        'MIGRATION_IMPORT_REJECTED',
        `The opening is dated the evening before go-live: ${addDays(today, -1)} or ${today}.`,
      );
    }
    return text;
  }

  /** 23:59:59 Dhaka on the opening date, or now if that is still ahead. */
  private openingInstant(asOf: IsoDate): Date {
    const evening = new Date(`${asOf}T23:59:59+06:00`);
    const now = new Date();
    return evening.getTime() > now.getTime() ? now : evening;
  }

  private async reconcile(tx: Tx, orgId: string): Promise<ReconciliationReport> {
    const opening = await repo.openingOf(tx, orgId);
    if (opening === undefined) {
      throw new MigrationError(
        'MIGRATION_NOT_FOUND',
        'The opening is not posted yet. `status` shows the trial balance of what is staged.',
      );
    }
    const posted = await this.stagedRows(tx, orgId, 'posted');
    const position = openingPosition(posted);

    // Each wallet's account, so the journal's account lines can be named by wallet.
    const walletByAccount = new Map<string, string>();
    for (const row of posted.wallets) {
      const account = await this.wallets.walletAccount(tx, orgId, row.walletId);
      if (account !== null) walletByAccount.set(account.accountId, row.walletId);
    }

    const sectionOf = (subtype: string): OpeningSection | null => {
      if ((WALLET_SUBTYPES as readonly string[]).includes(subtype)) return 'wallet';
      if (
        subtype === 'inventory' ||
        subtype === 'supplier_advance' ||
        subtype === 'supplier_payable' ||
        subtype === 'courier_receivable' ||
        subtype === 'opening_equity'
      ) {
        return subtype;
      }
      return null;
    };
    const refOf = (section: OpeningSection, accountId: string, partyId: string | null) => {
      if (section === 'wallet') return walletByAccount.get(accountId) ?? accountId;
      if (section === 'inventory' || section === 'opening_equity') return null;
      return partyId;
    };

    const lines = await this.ledger.journalLines(tx, orgId, opening.journal_id);
    const journal: ReconciliationFigure[] = [];
    let debit = 0n;
    let credit = 0n;
    for (const line of lines) {
      debit += line.debitPoisha;
      credit += line.creditPoisha;
      const section = sectionOf(line.subtype);
      if (section === null) continue;
      journal.push({
        section,
        refId: refOf(section, line.accountId, line.partyId),
        amountPoisha: normalSide(section, line.debitPoisha, line.creditPoisha),
      });
    }

    const modules: ReconciliationFigure[] = [];
    const valuation = await this.inventory.valuation(tx, orgId);
    modules.push({ section: 'inventory', refId: null, amountPoisha: valuation.stockValuePoisha });
    const balances = await this.ledger.balancesAsOf(tx, orgId, opening.as_of, [
      ...WALLET_SUBTYPES,
      'supplier_advance',
      'supplier_payable',
      'courier_receivable',
      'opening_equity',
    ]);
    for (const balance of balances) {
      const section = sectionOf(balance.subtype);
      if (section === null) continue;
      modules.push({
        section,
        refId: refOf(section, balance.accountId, balance.partyId),
        amountPoisha: normalSide(section, balance.debitPoisha, balance.creditPoisha),
      });
    }

    const report = reconcileOpening({
      position,
      journal,
      journalDebitPoisha: poisha(debit),
      journalCreditPoisha: poisha(credit),
      modules,
    });
    return {
      ...report,
      asOf: opening.as_of,
      journalId: opening.journal_id,
      signedOffBy: opening.signed_off_by,
      signedOffAt: opening.signed_off_at,
    };
  }
}
