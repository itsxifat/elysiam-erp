import { Inject, Injectable } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha, sameReceipt, type Poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { postingInstant } from './posting-date.js';
import * as repo from './supply.repository.js';
import { mapSupplyErrors, SupplyError } from './supply.errors.js';
import { assertSupplyDocument } from './suppliers.service.js';
import type {
  CreateSupplyInput,
  ReceiveSupplyInput,
  SupplyDraftInput,
  SupplyListQuery,
  UpdateSupplyDraftInput,
} from './supply.schemas.js';

/**
 * Supply entries: the one place purchase cost enters the system (invariant 5, §7).
 *
 * ## Receiving is one transaction, and that is check 1
 *
 * A receipt prices the lines, creates the stock movements, blends the weighted
 * average, posts `Dr Inventory / Cr Supplier payable` and flips the header — all
 * inside the caller's `withOrg()` transaction, with the movements and the journal done
 * by `INVENTORY_API.receiveSupply` so that pairing lives in one function rather than
 * in two modules hoping to agree. Make the journal step fail and every one of those
 * rolls back together: no movement, no cost on any line, no change to what the
 * supplier is owed. There is nothing to compensate for afterwards, which is the only
 * version of this that stays true under a crash.
 *
 * The order inside the transaction is load-bearing. The lines are priced **before** the
 * header flips, because `supply_lines_costed_when_received` refuses a received line
 * with no cost — and the header flips **after** the journal is posted, because the
 * header carries the journal's id and `supplies_status_journal` refuses a received
 * entry without one.
 *
 * ## Two ways in, and only one of them may see a price
 *
 * D-005: warehouse counts cartons, accounts prices them. So there are two entry
 * points. `createDraft` takes quantities and has no cost field anywhere in its schema;
 * `createAndReceive` and `receive` take prices and are gated on `read Cost`, which §6
 * gives to super_admin, org_admin and accounts and to nobody else. §6's Supply row
 * cannot express that on its own — it grants warehouse `create` and `update` — so the
 * cost-bearing routes declare the cost ability instead of the supply one (D-122).
 * `assertMayPrice` repeats the check here, because a route decorator is one refactor
 * away from being dropped and the thing it is protecting is the brand's margins.
 */

export interface SupplyLineInput {
  readonly skuId: string;
  readonly qty: number;
  readonly unitCostPoisha: Poisha;
}

@Injectable()
export class SuppliesService {
  constructor(
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    private readonly audit: AuditService,
  ) {}

  // --- reading ----------------------------------------------------------------

  async list(context: ActiveContext, request: object, query: SupplyListQuery) {
    const scope = scopeWhere(request, { branchId: sql`e.branch_id` });
    const withCost = canReadCost(context.roles, context.isSuperAdmin);

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listSupplies(tx, context.orgId, {
          scope,
          supplierId: query.supplierId,
          status: query.status,
          from: query.from,
          to: query.to,
        });

        return {
          items: rows.map((row) => ({
            id: row.id,
            supplierId: row.supplier_id,
            supplierName: row.supplier_name,
            locationId: row.location_id,
            branchId: row.branch_id,
            status: row.status,
            invoiceNumber: row.invoice_number,
            businessDate: row.business_date,
            journalId: row.journal_id,
            attachmentFileId: row.attachment_file_id,
          })),
          costWithheld: !withCost,
        };
      }),
    );
  }

  async detail(context: ActiveContext, request: object, supplyId: string) {
    const withCost = canReadCost(context.roles, context.isSuperAdmin);

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const entry = await repo.supplyById(tx, context.orgId, supplyId);
        if (entry === undefined) throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supply entry.');
        assertInScope(request, { branchId: entry.branch_id });

        const lines = await repo.supplyLines(tx, context.orgId, supplyId);
        const total = lines.reduce(
          (sum, line) => sum + BigInt(line.unit_cost_poisha ?? '0') * BigInt(line.qty),
          0n,
        );

        return {
          id: entry.id,
          supplierId: entry.supplier_id,
          supplierName: entry.supplier_name,
          locationId: entry.location_id,
          branchId: entry.branch_id,
          status: entry.status,
          invoiceNumber: entry.invoice_number,
          occurredAt: entry.occurred_at,
          businessDate: entry.business_date,
          attachmentFileId: entry.attachment_file_id,
          journalId: entry.journal_id,
          receivedBy: entry.received_by,
          costWithheld: !withCost,
          // Withheld by name as well as by route: `unitCostPoisha` is in `COST_FIELDS`
          // so `serializeFor` removes it whatever this returns, and the total is left
          // out entirely for a caller without `read:cost` because no serializer can
          // recognise a field called `totalCostPoisha` (D-085's problem exactly).
          ...(withCost ? { totalCostPoisha: total.toString() } : {}),
          lines: lines.map((line) => ({
            id: line.id,
            skuId: line.sku_id,
            skuCode: line.sku_code,
            productName: line.product_name,
            lineNo: line.line_no,
            qty: line.qty,
            ...(withCost ? { unitCostPoisha: line.unit_cost_poisha } : {}),
          })),
        };
      }),
    );
  }

  // --- the draft flow (D-005) --------------------------------------------------

  /**
   * A qty-only receipt draft from the warehouse.
   *
   * Idempotent on the client-generated `draftId`, which is what makes a double-tapped
   * Save on a phone in a warehouse create one draft rather than two. The replay answer
   * carries no line detail beyond the count: the caller may well be a role with no
   * `read Supply` at all, and answering a retry with more than the first call returned
   * would be a way to read an entry through the endpoint that writes it.
   */
  async createDraft(context: ActiveContext, request: AuditableRequest, input: SupplyDraftInput) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.supplyById(tx, context.orgId, input.draftId);
        if (existing !== undefined) {
          const lines = await repo.supplyLines(tx, context.orgId, input.draftId);
          // A replay answers only the same draft (D-432): same supplier, location, lines.
          assertSameReceipt(existing, lines, {
            supplierId: input.supplierId,
            locationId: input.locationId,
            lines: input.lines.map((line) => ({ ...line, unitCostPoisha: null })),
          });
          return { id: existing.id, status: existing.status, lineCount: lines.length };
        }

        await repo.insertSupply(tx, {
          orgId: context.orgId,
          id: input.draftId,
          supplierId: input.supplierId,
          locationId: input.locationId,
          invoiceNumber: input.invoiceNumber ?? null,
          createdBy: context.userId,
        });
        await this.writeLines(tx, context.orgId, input.draftId, input.lines);

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'supply.draft.created',
          entityType: 'Supply',
          entityId: input.draftId,
          before: null,
          after: {
            supplierId: input.supplierId,
            locationId: input.locationId,
            lineCount: input.lines.length,
            totalQty: input.lines.reduce((sum, line) => sum + line.qty, 0),
          },
          requestId: context.requestId,
          request,
        });

        return { id: input.draftId, status: 'draft' as const, lineCount: input.lines.length };
      }),
    );
  }

  async updateDraft(
    context: ActiveContext,
    request: AuditableRequest,
    supplyId: string,
    patch: UpdateSupplyDraftInput,
  ) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const entry = await repo.supplyForUpdate(tx, context.orgId, supplyId);
        if (entry === undefined) throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supply entry.');
        if (entry.status !== 'draft') {
          throw new SupplyError(
            'SUPPLY_IMMUTABLE',
            'That supply has been received; correct it with a supplier return.',
          );
        }

        await repo.updateSupplyDraft(tx, context.orgId, supplyId, {
          ...(patch.invoiceNumber === undefined ? {} : { invoiceNumber: patch.invoiceNumber }),
          ...(patch.locationId === undefined ? {} : { locationId: patch.locationId }),
        });
        if (patch.lines !== undefined) {
          // Replaced wholesale rather than diffed. A draft is a working document and
          // its lines have no identity worth preserving — and a diff would have to
          // decide what a missing line means, which is the kind of guess that silently
          // keeps a quantity nobody counted.
          await repo.deleteSupplyLines(tx, context.orgId, supplyId);
          await this.writeLines(tx, context.orgId, supplyId, patch.lines);
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'supply.draft.updated',
          entityType: 'Supply',
          entityId: supplyId,
          before: null,
          after: { lineCount: patch.lines?.length ?? null },
          requestId: context.requestId,
          request,
        });

        return { id: supplyId, status: 'draft' as const };
      }),
    );
  }

  /** Throw away a draft entered twice. A received entry is refused, by 0037 and here. */
  async deleteDraft(context: ActiveContext, request: AuditableRequest, supplyId: string) {
    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const removed = await repo.deleteSupplyDraft(tx, context.orgId, supplyId);
        if (removed === 0) {
          // A received entry, another org's, and one that never existed are one
          // answer. Distinguishing them would say whether an id exists.
          throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supply draft.');
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'supply.draft.deleted',
          entityType: 'Supply',
          entityId: supplyId,
          before: { status: 'draft' },
          after: null,
          requestId: context.requestId,
          request,
        });

        return { id: supplyId, deleted: true };
      }),
    );
  }

  // --- receiving --------------------------------------------------------------

  /** Price a draft and receive it: movements, weighted average and the journal. */
  async receive(
    context: ActiveContext,
    request: AuditableRequest,
    supplyId: string,
    input: ReceiveSupplyInput,
    now: Date = new Date(),
  ) {
    this.assertMayPrice(context);

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        /*
         * The header, locked.
         *
         * Two people pricing the same draft at the same moment would otherwise both
         * pass the `status = 'draft'` check, both create movements and both post — and
         * the journal's idempotency key would make the second post a no-op while its
         * movements were real, leaving stock the ledger does not account for. The lock
         * makes the second wait and then read `received`.
         */
        const entry = await repo.supplyForUpdate(tx, context.orgId, supplyId);
        if (entry === undefined) throw new SupplyError('SUPPLY_NOT_FOUND', 'No such supply entry.');
        assertInScope(request, { branchId: entry.branch_id });

        if (entry.status === 'received') {
          const received = await repo.supplyById(tx, context.orgId, supplyId);
          return {
            id: supplyId,
            status: 'received' as const,
            journalId: received?.journal_id ?? null,
            businessDate: received?.business_date ?? null,
            created: false,
          };
        }

        const existing = await repo.supplyLines(tx, context.orgId, supplyId);
        if (existing.length === 0) {
          throw new SupplyError('VALIDATION_FAILED', 'That draft has no lines to receive.');
        }

        const priced = new Map(input.lines.map((line) => [line.skuId, line]));
        for (const line of existing) {
          const price = priced.get(line.sku_id);
          if (price === undefined) {
            // Named, because the alternative is the database refusing a null cost
            // after the movements have been attempted — a 500-shaped answer to
            // "you missed a line".
            throw new SupplyError(
              'SUPPLY_COST_REQUIRED',
              `SKU ${line.sku_code} has no unit cost; every line is priced before an entry is received.`,
            );
          }
          priced.delete(line.sku_id);
        }
        if (priced.size > 0) {
          throw new SupplyError(
            'VALIDATION_FAILED',
            'A price was sent for a SKU that is not on that entry; change the lines first.',
          );
        }

        if (input.attachmentFileId !== undefined) {
          await assertSupplyDocument(tx, context.orgId, input.attachmentFileId);
        }

        // After the replay above, so a retry of a receipt made yesterday still answers (C6).
        const occurredAt = postingInstant(input.occurredAt, now);
        const lines = existing.map((line) => {
          const price = input.lines.find((candidate) => candidate.skuId === line.sku_id);
          return {
            skuId: line.sku_id,
            qty: price?.qty ?? line.qty,
            unitCostPoisha: poisha(price?.unitCostPoisha ?? '0'),
          };
        });

        for (const line of lines) {
          await repo.priceSupplyLine(tx, context.orgId, supplyId, {
            skuId: line.skuId,
            qty: line.qty,
            unitCostPoisha: line.unitCostPoisha,
          });
        }

        const posted = await this.inventory.receiveSupply(
          tx,
          { orgId: context.orgId, userId: context.userId },
          {
            supplyId,
            supplierId: entry.supplier_id,
            locationId: entry.location_id,
            branchId: entry.branch_id,
            occurredAt,
            lines,
            memo: input.memo ?? null,
          },
        );
        if (posted.journalId === null) {
          // `supplyReceivedDraft` refuses a receipt of no value, so this is
          // unreachable through the posting rule — but the header's CHECK needs a
          // journal id and a null here would surface as a constraint name.
          throw new SupplyError(
            'SUPPLY_COST_REQUIRED',
            'A supply with no value posts nothing; record it as a stock gain instead.',
          );
        }

        const date = businessDate(occurredAt);
        await repo.markSupplyReceived(tx, context.orgId, supplyId, {
          invoiceNumber: input.invoiceNumber ?? null,
          occurredAt,
          businessDate: date,
          attachmentFileId: input.attachmentFileId ?? null,
          journalId: posted.journalId,
          receivedBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'supply.received',
          entityType: 'Supply',
          entityId: supplyId,
          before: { status: 'draft' },
          after: {
            status: 'received',
            journalId: posted.journalId,
            businessDate: date,
            valuePoisha: posted.valuePoisha,
          },
          requestId: context.requestId,
          request,
        });

        return {
          id: supplyId,
          status: 'received' as const,
          journalId: posted.journalId,
          businessDate: date,
          totalCostPoisha: posted.valuePoisha,
          movementIds: posted.movementIds,
          created: true,
        };
      }),
    );
  }

  /** Enter and receive in one call, the way accounts works from a paper invoice. */
  async createAndReceive(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateSupplyInput,
    now: Date = new Date(),
  ) {
    this.assertMayPrice(context);

    return mapSupplyErrors(async () => {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.supplyById(tx, context.orgId, input.supplyId);
        if (existing !== undefined) {
          // A replay answers only the same receipt (D-432). Without this, a retry that
          // asked for different goods would be told it saved while nothing posted.
          assertSameReceipt(existing, await repo.supplyLines(tx, context.orgId, input.supplyId), {
            supplierId: input.supplierId,
            locationId: input.locationId,
            lines: input.lines,
          });
          return;
        }
        // Refused before the draft exists, so a date outside §7's window leaves nothing
        // behind (C6, D-414). `receive` checks again, after its replay.
        postingInstant(input.occurredAt, now);
        await repo.insertSupply(tx, {
          orgId: context.orgId,
          id: input.supplyId,
          supplierId: input.supplierId,
          locationId: input.locationId,
          invoiceNumber: input.invoiceNumber ?? null,
          createdBy: context.userId,
        });
        await this.writeLines(tx, context.orgId, input.supplyId, input.lines);
      });

      /*
       * A second transaction, not one.
       *
       * The draft and the receipt each have to be atomic, and they already are; what
       * this split buys is that a retry of the whole call lands on `receive`'s replay
       * path rather than on a duplicate-key error from the insert. The draft on its own
       * moves no stock and posts nothing, so a crash between the two leaves a draft
       * somebody can price — which is a state this module already understands.
       */
      return this.receive(
        context,
        request,
        input.supplyId,
        {
          lines: input.lines,
          ...(input.invoiceNumber === undefined ? {} : { invoiceNumber: input.invoiceNumber }),
          ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
          ...(input.attachmentFileId === undefined
            ? {}
            : { attachmentFileId: input.attachmentFileId }),
          ...(input.memo === undefined ? {} : { memo: input.memo }),
        },
        now,
      );
    });
  }

  private async writeLines(
    tx: Tx,
    orgId: string,
    supplyId: string,
    lines: readonly { skuId: string; qty: number; unitCostPoisha?: string }[],
  ): Promise<void> {
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      await repo.insertSupplyLine(tx, {
        orgId,
        supplyId,
        skuId: line.skuId,
        lineNo,
        qty: line.qty,
        unitCostPoisha: line.unitCostPoisha === undefined ? null : poisha(line.unitCostPoisha),
      });
    }
  }

  /**
   * Only a role that may see purchase cost may set one (D-005, invariant 5).
   *
   * The route already declares `read Cost`, so this is the second gate. It is here
   * because the first one is a decorator: a route renamed, split or copied loses it
   * silently, and what it is protecting is the figure every margin in the brand is
   * computed from.
   */
  private assertMayPrice(context: ActiveContext): void {
    if (!canReadCost(context.roles, context.isSuperAdmin)) {
      throw new SupplyError(
        'FORBIDDEN',
        'Your role records quantities; accounts enters the prices (D-005).',
      );
    }
  }
}

/**
 * Refuse a replayed id that asks for a different receipt (D-432, `sameReceipt` in
 * @elysium/domain): the supplier, the location and the lines must be the ones stored.
 */
function assertSameReceipt(
  stored: repo.SupplyRow,
  storedLines: readonly repo.SupplyLineRow[],
  requested: {
    readonly supplierId: string;
    readonly locationId: string;
    readonly lines: readonly { skuId: string; qty: number; unitCostPoisha?: string | null }[];
  },
): void {
  const same = sameReceipt(
    {
      supplierId: stored.supplier_id,
      locationId: stored.location_id,
      lines: storedLines.map((line) => ({
        skuId: line.sku_id,
        qty: line.qty,
        unitCostPoisha: line.unit_cost_poisha,
      })),
    },
    {
      supplierId: requested.supplierId,
      locationId: requested.locationId,
      lines: requested.lines.map((line) => ({
        skuId: line.skuId,
        qty: line.qty,
        unitCostPoisha: line.unitCostPoisha ?? null,
      })),
    },
  );
  if (!same) {
    throw new SupplyError(
      'IDEMPOTENCY_CONFLICT',
      'An earlier save of this entry went through with different goods, supplier or location. Check Supply entries; saving again records this as a new entry.',
    );
  }
}
