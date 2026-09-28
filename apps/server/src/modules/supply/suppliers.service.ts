import { Injectable } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate } from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './supply.repository.js';
import { mapSupplyErrors, SupplyError } from './supply.errors.js';
import type {
  CreateSupplierInput,
  SupplierContactInput,
  SupplierDocumentInput,
  SupplierListQuery,
  SupplierNoteInput,
  UpdateSupplierInput,
} from './supply.schemas.js';

/**
 * Suppliers: the profile, the people, the notes and the documents (M09 Build list).
 *
 * The list is the screen the purchasing team lives on, so it carries the two numbers
 * they need — what each supplier is owed and what they hold as an advance — derived
 * from `ledger.journal_lines` rather than stored. There is no `due_poisha` column to
 * drift out of step with the books.
 *
 * Both numbers are **supplier balances**, which §6 names as protected fields
 * alongside cost. Every route here needs `read Supply`, which today only org_admin and
 * accounts hold — both of which have `read:cost` — so the withholding below never
 * fires for the roles that exist. It is written anyway, and `costWithheld` says so in
 * the response, because the moment §6 grants a branch manager or a merchandiser
 * `read Supply` the safe answer has to already be in place. D-085 made the same choice
 * for ledger reports and for the same reason: `serializeFor` strips fields by *name*,
 * and there is no name it can recognise in a number called `duePoisha`.
 */

export interface SupplierBalances {
  /** What is owed: the payable's credit side less its debits. */
  readonly duePoisha: string;
  /** What the supplier holds unspent: the advance's debit side less its credits. */
  readonly advancePoisha: string;
}

function emptyBalances(): SupplierBalances {
  return { duePoisha: '0', advancePoisha: '0' };
}

/**
 * Fold the grouped ledger rows into a due and an advance per supplier.
 *
 * The signs are the accounts' normal sides and getting one backwards is the whole
 * risk here: `supplier_payable` is a liability, so credits are what is owed;
 * `supplier_advance` is an asset, so debits are what is held. Flipping either would
 * produce a plausible-looking list in which every supplier appears to owe the brand
 * money.
 */
export function foldBalances(
  rows: readonly repo.SupplierBalanceRow[],
): Map<string, SupplierBalances> {
  const totals = new Map<string, { due: bigint; advance: bigint }>();
  for (const row of rows) {
    const entry = totals.get(row.party_id) ?? { due: 0n, advance: 0n };
    const debit = BigInt(row.debit_poisha);
    const credit = BigInt(row.credit_poisha);
    if (row.subtype === 'supplier_payable') entry.due += credit - debit;
    else entry.advance += debit - credit;
    totals.set(row.party_id, entry);
  }
  return new Map(
    [...totals].map(([partyId, entry]) => [
      partyId,
      { duePoisha: entry.due.toString(), advancePoisha: entry.advance.toString() },
    ]),
  );
}

@Injectable()
export class SuppliersService {
  constructor(private readonly audit: AuditService) {}

  async list(context: ActiveContext, query: SupplierListQuery) {
    const asOf = query.asOf ?? businessDate(new Date());
    const withheld = !canReadCost(context.roles, context.isSuperAdmin);

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listSuppliers(tx, context.orgId, {
          q: query.q,
          includeInactive: query.includeInactive,
        });
        const balances = withheld
          ? new Map<string, SupplierBalances>()
          : foldBalances(
              await repo.supplierBalances(tx, context.orgId, { asOf, supplierId: undefined }),
            );

        return {
          asOf,
          costWithheld: withheld,
          items: rows.map((row) => ({
            id: row.id,
            code: row.code,
            name: row.name,
            phone: row.phone,
            email: row.email,
            address: row.address,
            paymentTermsDays: row.payment_terms_days,
            isActive: row.is_active,
            ...(withheld ? {} : (balances.get(row.id) ?? emptyBalances())),
          })),
        };
      }),
    );
  }

  async detail(context: ActiveContext, supplierId: string) {
    const asOf = businessDate(new Date());
    const withheld = !canReadCost(context.roles, context.isSuperAdmin);

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const supplier = await this.require(tx, context, supplierId);
        const [contacts, notes, documents, balanceRows] = await Promise.all([
          repo.listContacts(tx, context.orgId, supplierId),
          repo.listNotes(tx, context.orgId, supplierId),
          repo.listDocuments(tx, context.orgId, supplierId),
          withheld
            ? Promise.resolve([])
            : repo.supplierBalances(tx, context.orgId, { asOf, supplierId }),
        ]);
        const balances = foldBalances(balanceRows).get(supplierId) ?? emptyBalances();

        return {
          id: supplier.id,
          code: supplier.code,
          name: supplier.name,
          phone: supplier.phone,
          email: supplier.email,
          address: supplier.address,
          paymentTermsDays: supplier.payment_terms_days,
          isActive: supplier.is_active,
          asOf,
          costWithheld: withheld,
          ...(withheld ? {} : balances),
          contacts: contacts.map((row) => ({
            id: row.id,
            name: row.name,
            role: row.role,
            phone: row.phone,
            email: row.email,
            isPrimary: row.is_primary,
          })),
          notes: notes.map((row) => ({
            id: row.id,
            body: row.body,
            createdBy: row.created_by,
            createdAt: row.created_at,
          })),
          documents: documents.map((row) => ({
            id: row.id,
            fileObjectId: row.file_object_id,
            label: row.label,
            createdAt: row.created_at,
          })),
        };
      }),
    );
  }

  async create(context: ActiveContext, request: AuditableRequest, input: CreateSupplierInput) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const id = await repo.insertSupplier(tx, {
          orgId: context.orgId,
          code: input.code,
          name: input.name,
          phone: input.phone ?? null,
          email: input.email ?? null,
          address: input.address ?? null,
          paymentTermsDays: input.paymentTermsDays ?? null,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'supply.supplier.created',
          entityType: 'Supplier',
          entityId: id,
          before: null,
          // The phone is deliberately not in the audit payload. `redact()` masks known
          // personal-data keys, and a supplier's switchboard number is business data —
          // but the audit log is read far more widely than this table is, and the
          // supplier's name and code identify the row perfectly well (invariant 10).
          after: { code: input.code, name: input.name },
          requestId: context.requestId,
          request,
        });

        return { id, code: input.code, name: input.name, isActive: true };
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    supplierId: string,
    patch: UpdateSupplierInput,
  ) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await this.require(tx, context, supplierId);
        await repo.updateSupplier(tx, context.orgId, supplierId, patch);
        const after = await this.require(tx, context, supplierId);

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'supply.supplier.updated',
          entityType: 'Supplier',
          entityId: supplierId,
          before: { name: before.name, isActive: before.is_active },
          after: { name: after.name, isActive: after.is_active },
          requestId: context.requestId,
          request,
        });

        return { id: supplierId, name: after.name, isActive: after.is_active };
      }),
    );
  }

  async addContact(
    context: ActiveContext,
    request: AuditableRequest,
    supplierId: string,
    input: SupplierContactInput,
  ) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.require(tx, context, supplierId);
        const id = await repo.insertContact(tx, {
          orgId: context.orgId,
          supplierId,
          name: input.name,
          role: input.role ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          isPrimary: input.isPrimary,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'supply.supplier.contact.added',
          entityType: 'SupplierContact',
          entityId: id,
          before: null,
          after: { supplierId, name: input.name, role: input.role ?? null },
          requestId: context.requestId,
          request,
        });

        return { id, name: input.name, isPrimary: input.isPrimary };
      }),
    );
  }

  async addNote(
    context: ActiveContext,
    request: AuditableRequest,
    supplierId: string,
    input: SupplierNoteInput,
  ) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.require(tx, context, supplierId);
        const id = await repo.insertNote(tx, {
          orgId: context.orgId,
          supplierId,
          body: input.body,
          createdBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'supply.supplier.note.added',
          entityType: 'SupplierNote',
          entityId: id,
          before: null,
          after: { supplierId },
          requestId: context.requestId,
          request,
        });

        return { id, body: input.body };
      }),
    );
  }

  /**
   * Attach a document to a supplier.
   *
   * The file has to be a **stored, private `supply-document`**, checked here rather
   * than trusted: `PURPOSE_RULES` maps that purpose to `read Supply`, so it is the
   * purpose — not this row — that decides who may download the bytes. A quotation
   * uploaded as a `product-image` would be readable by every role with `read Catalog`,
   * which is everyone, and a public one would be readable by anyone with the URL,
   * because the public bucket is served with no authorization at all (§22).
   */
  async addDocument(
    context: ActiveContext,
    request: AuditableRequest,
    supplierId: string,
    input: SupplierDocumentInput,
  ) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.require(tx, context, supplierId);
        await assertSupplyDocument(tx, context.orgId, input.fileObjectId);

        const id = await repo.insertDocument(tx, {
          orgId: context.orgId,
          supplierId,
          fileObjectId: input.fileObjectId,
          label: input.label,
          createdBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'supply.supplier.document.attached',
          entityType: 'SupplierDocument',
          entityId: id,
          before: null,
          after: { supplierId, label: input.label, fileObjectId: input.fileObjectId },
          requestId: context.requestId,
          request,
        });

        return { id, label: input.label, fileObjectId: input.fileObjectId };
      }),
    );
  }

  /** The supplier, or a 404. Another org's is already invisible under RLS. */
  private async require(
    tx: Tx,
    context: ActiveContext,
    supplierId: string,
  ): Promise<repo.SupplierRow> {
    const supplier = await repo.supplierById(tx, context.orgId, supplierId);
    if (supplier === undefined) {
      throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supplier.');
    }
    return supplier;
  }
}

/** Shared by the supplier documents and a supply entry's challan attachment. */
export async function assertSupplyDocument(tx: Tx, orgId: string, fileId: string): Promise<void> {
  const file = await repo.attachment(tx, orgId, fileId);
  if (file?.status !== 'stored') {
    throw new SupplyError('SUPPLY_NOT_FOUND', 'That file has not finished uploading.');
  }
  if (file.purpose !== 'supply-document') {
    throw new SupplyError(
      'VALIDATION_FAILED',
      'Upload it with the supply-document purpose, so only the right roles can read it.',
    );
  }
  if (file.visibility !== 'private') {
    throw new SupplyError(
      'VALIDATION_FAILED',
      'A supplier document carries purchase prices and must be a private file (§22).',
    );
  }
}
