import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { canReadCost, defineAbilityFor } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha, sameReceipt, stockInHandValue, type Poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from './inventory.api.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import * as stockRepo from './inventory.repository.js';
import { stockIdSchema } from './inventory.schemas.js';
import * as repo from './stock-in-hand.repository.js';
import type {
  CloseWindowInput,
  CreateStockInHandInput,
  PostStockInHandInput,
  ReopenWindowInput,
  ReverseStockInHandInput,
  StockInHandDraftInput,
  StockInHandListQuery,
  UpdateStockInHandDraftInput,
} from './stock-in-hand.schemas.js';

/**
 * Stock in hand at the start, and the window it is allowed in (M38a, D-602).
 *
 * A brand starting on the ERP already holds stock. Each entry is a location and the pieces
 * counted into it at what each cost; posting it writes `opening_balance` movements (the
 * weighted average blends exactly as a receipt's) and one journal, Dr Inventory / Cr Opening
 * balance equity, keyed on the entry (`stock_in_hand:<id>:posted`), through
 * `INVENTORY_API.receiveStockInHand`, in one transaction.
 *
 * ## Who does what (mirrors supply's D-005)
 *
 * - The warehouse counts: `create Supply` writes a **draft** of quantities. Its schema has
 *   no cost field, and it is strict.
 * - Someone holding `read:cost` (org_admin, accounts) prices and posts: `POST /:id/post`,
 *   repeating the location and the pieces they read (a draft changed since is refused), or
 *   enters and posts in one go. `assertMayPrice` repeats the route's check, because a
 *   decorator is one refactor from being dropped and what it protects is the brand's cost.
 * - A posted entry is taken back out only by an approved `stock_in_hand_reversal`, asked
 *   for by someone who may post and decided by an org admin who did not ask, while the
 *   window is open (invariant 2: the ledger reverses the entry's journal).
 *
 * ## The window
 *
 * Open on a new brand (migration 0114 closed it for every brand that had already opened its
 * books or traded). An org admin closes it once everything is counted in; after that, stock
 * arrives only from suppliers, transfers, returns and approved adjustments, and a draft, a
 * post and a reversal are refused with `OPENING_STOCK_CLOSED` here, in `InventoryApi`, and
 * again by the database. Reopening is an `opening_stock_reopen` approval for that close,
 * raised here under the window's lock and carried out by the executor below in the
 * approving transaction; the database refuses closed → open without that approval.
 *
 * ## Retries (D-432's pattern)
 *
 * The entry id is the client's key, kept across retries until the server answers. A known
 * id replays only for the same location and lines (`sameReceipt`); anything else is a 409
 * `IDEMPOTENCY_CONFLICT`, so a retry after a lost response returns the first entry rather
 * than posting the stock twice, and a retry asking for other stock is refused loudly.
 */

const WINDOW_PAYLOAD = { window: 'opening_stock' } as const;

export interface WindowView {
  readonly open: boolean;
  readonly closedAt: Date | null;
  /** Who closed it: only for a caller who may close and reopen it (`approve StockAdjustment`). */
  readonly closedBy?: string | null;
  readonly reopenedAt: Date | null;
  readonly reopenPending: boolean;
}

interface CostedLine {
  readonly skuId: string;
  readonly qty: number;
  readonly unitCostPoisha: Poisha;
}

@Injectable()
export class StockInHandService implements OnModuleInit {
  constructor(
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('opening_stock_reopen', this.executeReopen);
    this.approvals.registerExecutor('stock_in_hand_reversal', this.executeReversal);
  }

  // --- the window -----------------------------------------------------------------------

  async window(context: ActiveContext): Promise<WindowView> {
    const row = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      repo.windowOf(tx, context.orgId),
    );
    const reopenPending =
      row?.status === 'closed' &&
      (await this.approvals.hasPending(context, {
        type: 'opening_stock_reopen',
        payloadKey: 'window',
        value: WINDOW_PAYLOAD.window,
      }));
    // A user id is for the people who decide the window, not for every role reading stock.
    const mayDecide = defineAbilityFor(context).can('approve', 'StockAdjustment');
    return {
      open: row === undefined || row.status === 'open',
      closedAt: repo.toInstant(row?.closed_at ?? null),
      ...(mayDecide ? { closedBy: row?.closed_by ?? null } : {}),
      reopenedAt: repo.toInstant(row?.reopened_at ?? null),
      reopenPending,
    };
  }

  /** Close the window: everything is counted in. Audited; closing twice changes nothing. */
  async close(context: ActiveContext, request: AuditableRequest, input: CloseWindowInput) {
    return mapStockErrors(async () => {
      await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // `for update`: an entry being posted holds the row `for share`, so the close
        // waits for it, and every entry after the close sees the window closed.
        const current = await repo.lockWindow(tx, context.orgId, 'update');
        if (current.status === 'closed') return;
        const closed = await repo.closeWindow(tx, context.orgId, context.userId);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.opening_stock.closed',
          entityType: 'OpeningStockWindow',
          entityId: context.orgId,
          before: { status: 'open' },
          after: {
            status: 'closed',
            closedAt: repo.toInstant(closed.closed_at)?.toISOString() ?? null,
            note: input.note ?? null,
          },
          requestId: context.requestId,
          request,
        });
      });
      return this.window(context);
    });
  }

  /**
   * Ask to reopen a closed window. Raises an `opening_stock_reopen` for a second org admin
   * (or a super admin): never auto-approved, no amount, raised only here, for this close.
   *
   * In one transaction under the window's `for update` lock, so two people asking at once
   * raise one request, and the request names the close it reopens (`closedAt`): one left
   * over from an earlier close is refused by the executor and by the database.
   */
  async requestReopen(context: ActiveContext, request: AuditableRequest, input: ReopenWindowInput) {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.lockWindow(tx, context.orgId, 'update');
        if (row.status === 'open') {
          throw new StockError(
            'OPENING_STOCK_INVALID',
            'The opening stock window is already open.',
          );
        }
        if (
          await this.approvals.hasPending(
            context,
            {
              type: 'opening_stock_reopen',
              payloadKey: 'window',
              value: WINDOW_PAYLOAD.window,
            },
            tx,
          )
        ) {
          throw new StockError(
            'OPENING_STOCK_REOPEN_PENDING',
            'A request to reopen it is already waiting for a second admin.',
          );
        }
        const raised = await this.approvals.request(context, {
          type: 'opening_stock_reopen',
          amountPoisha: null,
          payload: {
            ...WINDOW_PAYLOAD,
            closedAt: repo.toInstant(row.closed_at)?.toISOString() ?? null,
          },
          reason: input.reason,
          request,
          raisedByModule: true,
          holdForChecker: true,
          tx,
        });
        return { approvalId: raised.id, status: raised.status };
      }),
    );
  }

  /**
   * The reopen executor: runs inside the approving transaction, as the checker. A request
   * raised for an earlier close is refused, so the checker rejects it and the admin asks
   * again; the database's trigger checks the approval it names again (type, approved,
   * decided after the close, for this close).
   */
  private readonly executeReopen: ApprovalExecutor = async (tx, { context, approval, request }) =>
    mapStockErrors(async () => {
      const window = await repo.lockWindow(tx, context.orgId, 'update');
      // Already open (another request reopened it first): nothing to do, nothing to undo.
      if (window.status === 'open') return;
      const closedAt = repo.toInstant(window.closed_at)?.toISOString() ?? null;
      if (approval.payload.closedAt !== closedAt) {
        throw new StockError(
          'OPENING_STOCK_REOPEN_UNAPPROVED',
          'That request was raised for an earlier close of the window. Reject it, and ask again if the window still needs reopening.',
        );
      }
      const reopened = await repo.reopenWindow(tx, context.orgId, {
        approvalId: approval.id,
        userId: context.userId,
      });
      if (reopened === undefined) return;
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'inventory.opening_stock.reopened',
        entityType: 'OpeningStockWindow',
        entityId: context.orgId,
        before: { status: 'closed', closedAt },
        after: { status: 'open', approvalId: approval.id, requestedBy: approval.requestedBy },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });

  // --- reading entries ------------------------------------------------------------------

  async list(context: ActiveContext, request: object, query: StockInHandListQuery) {
    const withCost = canReadCost(context.roles, context.isSuperAdmin);
    const scope = scopeWhere(request, { branchId: sql`e.branch_id` });
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listEntries(tx, context.orgId, {
          scope,
          status: query.status,
        });
        const locations = await this.locationNames(
          tx,
          context.orgId,
          rows.map((row) => row.location_id),
        );
        return {
          items: rows.map((row) => ({
            id: row.id,
            status: row.status,
            locationId: row.location_id,
            locationName: locations.get(row.location_id) ?? '',
            memo: row.memo,
            lineCount: row.line_count,
            totalQty: row.total_qty,
            businessDate: row.business_date,
            createdBy: row.created_by,
            createdAt: row.created_at,
            postedAt: row.posted_at,
            reversedAt: row.reversed_at,
            // `stockValuePoisha` is in COST_FIELDS, so `serializeFor` removes it for a role
            // without `read:cost` too; it is left out here as well (D-085's lesson).
            ...(withCost ? { stockValuePoisha: row.stock_value_poisha } : {}),
          })),
          costWithheld: !withCost,
        };
      }),
    );
  }

  async detail(context: ActiveContext, request: object, entryId: string) {
    const withCost = canReadCost(context.roles, context.isSuperAdmin);
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        this.view(tx, context, request, entryId, withCost),
      ),
    );
  }

  // --- the draft flow (warehouse) -------------------------------------------------------

  async createDraft(
    context: ActiveContext,
    request: AuditableRequest,
    input: StockInHandDraftInput,
  ) {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.entryById(tx, context.orgId, input.entryId);
        if (existing !== undefined) {
          assertInScope(request, { branchId: existing.branch_id });
          // Quantities only, whatever the entry has become since: a draft retried after
          // accounts priced and posted it is the same count, and answers with what it is.
          await this.assertSameEntry(tx, context.orgId, existing, {
            locationId: input.locationId,
            lines: input.lines.map((line) => ({ ...line, unitCostPoisha: null })),
          });
          return { id: existing.id, status: existing.status, lineCount: input.lines.length };
        }

        await this.assertWindowOpen(tx, context.orgId);
        const location = await this.receivingLocation(tx, context.orgId, input.locationId);
        assertInScope(request, { branchId: location.branch_id });
        await this.assertSkus(tx, context.orgId, input.lines);

        await repo.insertEntry(tx, {
          orgId: context.orgId,
          id: input.entryId,
          locationId: location.id,
          branchId: location.branch_id,
          memo: input.memo ?? null,
          createdBy: context.userId,
        });
        await repo.replaceLines(
          tx,
          context.orgId,
          input.entryId,
          input.lines.map((line) => ({ ...line, unitCostPoisha: null })),
        );

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'inventory.stock_in_hand.drafted',
          entityType: 'StockInHand',
          entityId: input.entryId,
          before: null,
          after: {
            locationId: location.id,
            lines: input.lines.map((line) => ({ skuId: line.skuId, qty: line.qty })),
            totalQty: input.lines.reduce((sum, line) => sum + line.qty, 0),
          },
          requestId: context.requestId,
          request,
        });
        return { id: input.entryId, status: 'draft' as const, lineCount: input.lines.length };
      }),
    );
  }

  async updateDraft(
    context: ActiveContext,
    request: AuditableRequest,
    entryId: string,
    patch: UpdateStockInHandDraftInput,
  ) {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const entry = await repo.lockEntry(tx, context.orgId, entryId);
        if (entry === undefined) {
          throw new StockError('STOCK_IN_HAND_NOT_FOUND', 'No such stock-in-hand entry.');
        }
        assertInScope(request, { branchId: entry.branch_id });
        if (entry.status !== 'draft') {
          throw new StockError(
            'STOCK_IN_HAND_IMMUTABLE',
            'That entry is posted; ask to reverse it, or correct the stock with a count.',
          );
        }
        await this.assertWindowOpen(tx, context.orgId);
        const before = await this.draftSnapshot(tx, context.orgId, entry);

        if (patch.locationId !== undefined) {
          const location = await this.receivingLocation(tx, context.orgId, patch.locationId);
          assertInScope(request, { branchId: location.branch_id });
          await repo.updateDraft(tx, context.orgId, entryId, {
            locationId: location.id,
            branchId: location.branch_id,
          });
        }
        if (patch.memo !== undefined) {
          await repo.updateDraft(tx, context.orgId, entryId, { memo: patch.memo });
        }
        if (patch.lines !== undefined) {
          await this.assertSkus(tx, context.orgId, patch.lines);
          // Replaced wholesale: a draft's lines have no identity worth keeping, and a diff
          // would have to guess what a missing line means (as supply's drafts do).
          await repo.replaceLines(
            tx,
            context.orgId,
            entryId,
            patch.lines.map((line) => ({ ...line, unitCostPoisha: null })),
          );
        }

        const changed = await repo.entryById(tx, context.orgId, entryId);
        const after =
          changed === undefined ? null : await this.draftSnapshot(tx, context.orgId, changed);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.stock_in_hand.draft_updated',
          entityType: 'StockInHand',
          entityId: entryId,
          // The pieces before and after: what the person posting it later may not have seen.
          before,
          after,
          requestId: context.requestId,
          request,
        });
        return { id: entryId, status: 'draft' as const };
      }),
    );
  }

  async deleteDraft(context: ActiveContext, request: AuditableRequest, entryId: string) {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const entry = await repo.entryById(tx, context.orgId, entryId);
        if (entry !== undefined) assertInScope(request, { branchId: entry.branch_id });
        const removed = await repo.deleteDraft(tx, context.orgId, entryId);
        if (removed === 0) {
          // A posted entry, another brand's and one that never existed are one answer.
          throw new StockError('STOCK_IN_HAND_NOT_FOUND', 'No such stock-in-hand draft.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'inventory.stock_in_hand.draft_deleted',
          entityType: 'StockInHand',
          entityId: entryId,
          before: { status: 'draft' },
          after: null,
          requestId: context.requestId,
          request,
        });
        return { id: entryId, deleted: true };
      }),
    );
  }

  // --- posting (read:cost) --------------------------------------------------------------

  /** Enter and post in one transaction, the way the new-product form and the owner work. */
  async createAndPost(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateStockInHandInput,
    now: Date = new Date(),
  ) {
    this.assertMayPrice(context);
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const existing = await repo.lockEntry(tx, context.orgId, input.entryId);
        if (existing !== undefined) {
          assertInScope(request, { branchId: existing.branch_id });
          await this.assertSameEntry(tx, context.orgId, existing, input);
          if (existing.status === 'posted') return this.postedAnswer(existing, false);
          if (existing.status === 'reversed') throw this.reversedError();
          // A draft under this key with these lines: price and post it.
        } else {
          await this.assertWindowOpen(tx, context.orgId);
          const location = await this.receivingLocation(tx, context.orgId, input.locationId);
          assertInScope(request, { branchId: location.branch_id });
          await this.assertSkus(tx, context.orgId, input.lines);
          await repo.insertEntry(tx, {
            orgId: context.orgId,
            id: input.entryId,
            locationId: location.id,
            branchId: location.branch_id,
            memo: input.memo ?? null,
            createdBy: context.userId,
          });
          await repo.replaceLines(
            tx,
            context.orgId,
            input.entryId,
            input.lines.map((line) => ({
              skuId: line.skuId,
              qty: line.qty,
              unitCostPoisha: BigInt(line.unitCostPoisha),
            })),
          );
        }
        return this.postLocked(tx, context, request, input.entryId, input.lines, now);
      }),
    );
  }

  /**
   * Price a draft and post it: only the draft the person posting it read. The request
   * repeats the location and every SKU's pieces; a draft changed since (relocated, a line
   * added or recounted) is refused with `STOCK_IN_HAND_CHANGED` rather than posted.
   */
  async post(
    context: ActiveContext,
    request: AuditableRequest,
    entryId: string,
    input: PostStockInHandInput,
    now: Date = new Date(),
  ) {
    this.assertMayPrice(context);
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const entry = await repo.lockEntry(tx, context.orgId, entryId);
        if (entry === undefined) {
          throw new StockError('STOCK_IN_HAND_NOT_FOUND', 'No such stock-in-hand entry.');
        }
        assertInScope(request, { branchId: entry.branch_id });
        if (entry.status !== 'draft') {
          // A retry of this post replays; any other post of a posted entry is a conflict.
          await this.assertSameEntry(tx, context.orgId, entry, {
            locationId: input.locationId,
            lines: input.lines,
          });
          if (entry.status === 'reversed') throw this.reversedError();
          return this.postedAnswer(entry, false);
        }

        const lines = await repo.linesOf(tx, context.orgId, entryId);
        const seen = sameReceipt(
          {
            supplierId: '',
            locationId: entry.location_id,
            lines: lines.map((line) => ({
              skuId: line.sku_id,
              qty: line.qty,
              unitCostPoisha: null,
            })),
          },
          {
            supplierId: '',
            locationId: input.locationId,
            lines: input.lines.map((line) => ({
              skuId: line.skuId,
              qty: line.qty,
              unitCostPoisha: null,
            })),
          },
        );
        if (!seen) {
          throw new StockError(
            'STOCK_IN_HAND_CHANGED',
            'That draft changed after you opened it: other pieces or another location. Open it again and check the pieces before posting.',
          );
        }
        return this.postLocked(tx, context, request, entryId, input.lines, now);
      }),
    );
  }

  /**
   * Price every line of a locked draft, post its movements and journal, mark it posted.
   *
   * The order is load-bearing: the window is locked `for share` first (a close waits for
   * this transaction, or this one sees it closed); the lines are priced before the header
   * flips (the trigger refuses a posted entry with an unpriced line); the header flips
   * after the journal exists (the CHECK refuses a posted entry with no journal, and the
   * trigger one whose journal is not its own or not worth what its lines are).
   */
  private async postLocked(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    entryId: string,
    prices: readonly { readonly skuId: string; readonly unitCostPoisha: string }[],
    now: Date,
  ) {
    await this.assertWindowOpen(tx, context.orgId);
    const entry = await repo.lockEntry(tx, context.orgId, entryId);
    if (entry === undefined) {
      throw new StockError('STOCK_IN_HAND_NOT_FOUND', 'No such stock-in-hand entry.');
    }
    const lines = await repo.linesOf(tx, context.orgId, entryId);
    if (lines.length === 0) {
      throw new StockError('STOCK_IN_HAND_INVALID', 'That entry has no lines to post.');
    }

    const priced = new Map(prices.map((line) => [line.skuId, line.unitCostPoisha]));
    for (const line of lines) {
      if (!priced.has(line.sku_id)) {
        throw new StockError(
          'STOCK_IN_HAND_COST_REQUIRED',
          'Every line needs a cost per piece before the entry posts.',
        );
      }
    }
    if (priced.size !== lines.length) {
      throw new StockError(
        'STOCK_IN_HAND_INVALID',
        'A cost was sent for a SKU that is not on that entry; change the lines first.',
      );
    }

    const costed: CostedLine[] = lines.map((line) => ({
      skuId: line.sku_id,
      qty: line.qty,
      unitCostPoisha: poisha(priced.get(line.sku_id) ?? '0'),
    }));
    for (const line of costed) {
      await repo.priceLine(tx, context.orgId, entryId, line.skuId, line.unitCostPoisha);
    }

    const occurredAt = now;
    const posted = await this.inventory.receiveStockInHand(
      tx,
      { orgId: context.orgId, userId: context.userId },
      {
        entryId,
        locationId: entry.location_id,
        branchId: entry.branch_id,
        occurredAt,
        lines: costed,
        memo: entry.memo ?? null,
      },
    );
    if (posted.journalId === null) {
      // `stockInHandDraft` refuses a value of zero, so this is unreachable through the rule,
      // but the CHECK needs a journal id and a null would surface as a constraint name.
      throw new StockError(
        'STOCK_IN_HAND_COST_REQUIRED',
        'Stock in hand of no value posts nothing.',
      );
    }

    const date = businessDate(occurredAt);
    await repo.markPosted(tx, context.orgId, entryId, {
      occurredAt,
      businessDate: date,
      journalId: posted.journalId,
      postedBy: context.userId,
    });

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: 'inventory.stock_in_hand.posted',
      entityType: 'StockInHand',
      entityId: entryId,
      before: { status: 'draft' },
      after: {
        status: 'posted',
        locationId: entry.location_id,
        journalId: posted.journalId,
        businessDate: date,
        totalQty: costed.reduce((sum, line) => sum + line.qty, 0),
        valuePoisha: posted.valuePoisha,
      },
      requestId: context.requestId,
      request,
    });

    return {
      id: entryId,
      status: 'posted' as const,
      journalId: posted.journalId,
      businessDate: date,
      stockValuePoisha: posted.valuePoisha,
      movementIds: posted.movementIds,
      created: true,
    };
  }

  private postedAnswer(entry: repo.EntryRow, created: boolean) {
    return {
      id: entry.id,
      status: 'posted' as const,
      journalId: entry.journal_id,
      businessDate: entry.business_date,
      movementIds: [] as string[],
      created,
    };
  }

  private reversedError(): StockError {
    return new StockError(
      'STOCK_IN_HAND_IMMUTABLE',
      'That entry was posted and has since been reversed; enter the stock again as a new entry.',
    );
  }

  // --- reversing a posted entry (read:cost asks, an org admin decides) -------------------

  /**
   * Ask to take a posted entry back out (D-602): a `stock_in_hand_reversal` for an org
   * admin who did not ask (or a super admin), valued at what the entry posted, never
   * auto-approved, raised only here. Refused now rather than at the decision when the
   * window is closed, when one is already waiting, or when an entry's SKU is no longer at
   * the cost the entry brought it in at (the reversal is exact or not at all).
   */
  async requestReversal(
    context: ActiveContext,
    request: AuditableRequest,
    entryId: string,
    input: ReverseStockInHandInput,
  ) {
    this.assertMayPrice(context);
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.assertWindowOpen(tx, context.orgId);
        const entry = await repo.lockEntry(tx, context.orgId, entryId);
        if (entry === undefined) {
          throw new StockError('STOCK_IN_HAND_NOT_FOUND', 'No such stock-in-hand entry.');
        }
        assertInScope(request, { branchId: entry.branch_id });
        if (entry.status === 'draft') {
          throw new StockError(
            'STOCK_IN_HAND_INVALID',
            'A draft has posted nothing to reverse; delete it instead.',
          );
        }
        if (entry.status === 'reversed') {
          throw new StockError('STOCK_IN_HAND_IMMUTABLE', 'That entry is already reversed.');
        }
        if (
          await this.approvals.hasPending(
            context,
            { type: 'stock_in_hand_reversal', payloadKey: 'entryId', value: entryId },
            tx,
          )
        ) {
          throw new StockError(
            'STOCK_IN_HAND_REVERSAL_BLOCKED',
            'A reversal of this entry is already waiting for a second admin.',
          );
        }

        const lines = this.costedLines(await repo.linesOf(tx, context.orgId, entryId));
        await this.assertStillAtEntryCost(tx, context.orgId, lines);
        const value = stockInHandValue(lines);

        const raised = await this.approvals.request(context, {
          type: 'stock_in_hand_reversal',
          amountPoisha: value,
          // The entry the executor reverses and why; never an amount (D-078).
          payload: { entryId, journalId: entry.journal_id, reason: input.reason },
          reason: input.reason,
          request,
          amountDerivedByServer: true,
          raisedByModule: true,
          holdForChecker: true,
          tx,
        });
        return { approvalId: raised.id, status: raised.status };
      }),
    );
  }

  /**
   * The reversal executor, inside the approving transaction, as the checker: the entry's
   * pieces out at their cost and the ledger's reversal of its journal
   * (`InventoryApi.reverseStockInHand`), then the entry marked reversed. Indifferent to a
   * request naming no entry it can reverse (nothing else raises this type, D-078's shape);
   * an approval for another value than the entry's is refused.
   */
  private readonly executeReversal: ApprovalExecutor = async (tx, { context, approval, request }) =>
    mapStockErrors(async () => {
      const parsedId = stockIdSchema.safeParse(approval.payload.entryId);
      if (!parsedId.success) return;
      const entryId = parsedId.data;
      const entry = await repo.lockEntry(tx, context.orgId, entryId);
      if (entry?.status !== 'posted' || entry.journal_id === null) return;

      const lines = this.costedLines(await repo.linesOf(tx, context.orgId, entryId));
      const value = stockInHandValue(lines);
      if (approval.amountPoisha === null || approval.amountPoisha !== value) {
        throw new StockError(
          'IDEMPOTENCY_CONFLICT',
          'That approval is for a different value than the entry it names.',
        );
      }
      const reason =
        typeof approval.payload.reason === 'string' && approval.payload.reason.trim() !== ''
          ? approval.payload.reason.trim()
          : 'Stock in hand reversed';

      const reversed = await this.inventory.reverseStockInHand(
        tx,
        { orgId: context.orgId, userId: context.userId },
        {
          entryId,
          locationId: entry.location_id,
          journalId: entry.journal_id,
          occurredAt: new Date(),
          lines,
          reason,
        },
      );
      if (reversed.journalId === null) {
        throw new StockError('STOCK_IN_HAND_INVALID', 'The ledger did not reverse that entry.');
      }
      await repo.markReversed(tx, context.orgId, entryId, {
        reversalJournalId: reversed.journalId,
        approvalId: approval.id,
        reversedBy: context.userId,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'inventory.stock_in_hand.reversed',
        entityType: 'StockInHand',
        entityId: entryId,
        before: { status: 'posted', journalId: entry.journal_id },
        after: {
          status: 'reversed',
          reversalJournalId: reversed.journalId,
          approvalId: approval.id,
          requestedBy: approval.requestedBy,
          totalQty: lines.reduce((sum, line) => sum + line.qty, 0),
          valuePoisha: value.toString(),
        },
        requestId: context.requestId,
        ...(request === undefined ? {} : { request }),
      });
    });

  private costedLines(lines: readonly repo.LineRow[]): CostedLine[] {
    return lines.map((line) => {
      if (line.unit_cost_poisha === null) {
        throw new StockError('STOCK_IN_HAND_INVALID', 'A posted line has no cost.');
      }
      return { skuId: line.sku_id, qty: line.qty, unitCostPoisha: poisha(line.unit_cost_poisha) };
    });
  }

  /** The early answer to `reverseStockInHand`'s own check, read without a lock. */
  private async assertStillAtEntryCost(
    tx: Tx,
    orgId: string,
    lines: readonly CostedLine[],
  ): Promise<void> {
    const costs = await stockRepo.costsFor(
      tx,
      orgId,
      lines.map((line) => line.skuId),
    );
    const average = new Map(costs.map((row) => [row.sku_id, BigInt(row.wac_poisha)]));
    for (const line of lines) {
      if (average.get(line.skuId) !== line.unitCostPoisha) {
        throw new StockError(
          'STOCK_IN_HAND_REVERSAL_BLOCKED',
          'Those pieces have since been averaged with stock at another cost, so they cannot be taken out at the cost they came in at. Correct the stock with a count instead.',
        );
      }
    }
  }

  // --- checks ---------------------------------------------------------------------------

  /** Refused with a typed error once the brand's window is closed (D-602). */
  private async assertWindowOpen(tx: Tx, orgId: string): Promise<void> {
    const window = await repo.lockWindow(tx, orgId, 'share');
    if (window.status === 'closed') {
      throw new StockError(
        'OPENING_STOCK_CLOSED',
        'The opening stock window is closed: stock now comes in from a supplier, a transfer, a return or an approved adjustment.',
      );
    }
  }

  /** A warehouse or showroom of this brand that is in use. */
  private async receivingLocation(
    tx: Tx,
    orgId: string,
    locationId: string,
  ): Promise<stockRepo.LocationRow> {
    const location = await stockRepo.locationById(tx, orgId, locationId);
    if (location === undefined) {
      throw new StockError('STOCK_LOCATION_INVALID', 'No such location in this brand.');
    }
    if (!location.is_active) {
      throw new StockError('STOCK_LOCATION_INVALID', 'That location is switched off.');
    }
    if (location.kind !== 'warehouse' && location.kind !== 'showroom') {
      throw new StockError(
        'STOCK_LOCATION_INVALID',
        'Stock in hand is counted into a warehouse or a showroom.',
      );
    }
    return location;
  }

  /** Every SKU is this brand's. Archived SKUs may still be counted in: they are on a shelf. */
  private async assertSkus(
    tx: Tx,
    orgId: string,
    lines: readonly { readonly skuId: string }[],
  ): Promise<void> {
    const ids = [...new Set(lines.map((line) => line.skuId))];
    const found = await this.catalog.skusByIds(tx, orgId, ids);
    if (found.length !== ids.length) {
      throw new StockError('STOCK_NOT_FOUND', 'One of those SKUs is not in this brand.');
    }
  }

  /**
   * A replayed id answers only for the same entry (D-432): the same location and the same
   * lines, order aside. Costs are compared when both sides have them (a posted entry and a
   * priced request); otherwise quantities alone, so a warehouse draft can be posted through
   * the enter-and-post call with its own key, and a draft retried after it was posted
   * replays.
   */
  private async assertSameEntry(
    tx: Tx,
    orgId: string,
    stored: repo.EntryRow,
    requested: {
      readonly locationId: string;
      readonly lines: readonly {
        readonly skuId: string;
        readonly qty: number;
        readonly unitCostPoisha?: string | null;
      }[];
    },
  ): Promise<void> {
    const lines = await repo.linesOf(tx, orgId, stored.id);
    const compareCost =
      stored.status !== 'draft' &&
      requested.lines.every(
        (line) => line.unitCostPoisha !== undefined && line.unitCostPoisha !== null,
      );
    const same = sameReceipt(
      {
        supplierId: '',
        locationId: stored.location_id,
        lines: lines.map((line) => ({
          skuId: line.sku_id,
          qty: line.qty,
          unitCostPoisha: compareCost ? line.unit_cost_poisha : null,
        })),
      },
      {
        supplierId: '',
        locationId: requested.locationId,
        lines: requested.lines.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          unitCostPoisha: compareCost ? (line.unitCostPoisha ?? null) : null,
        })),
      },
    );
    if (!same) {
      throw new StockError(
        'IDEMPOTENCY_CONFLICT',
        'An earlier save of this entry went through with other stock or another location. Check Stock in hand; saving again records this as a new entry.',
      );
    }
  }

  private assertMayPrice(context: ActiveContext): void {
    if (!canReadCost(context.roles, context.isSuperAdmin)) {
      throw new StockError(
        'FORBIDDEN',
        'Your role counts the pieces; accounts or an admin enters what they cost.',
      );
    }
  }

  /** What a draft holds, for its audit entries: where, and how many of each SKU. */
  private async draftSnapshot(tx: Tx, orgId: string, entry: repo.EntryRow) {
    const lines = await repo.linesOf(tx, orgId, entry.id);
    return {
      locationId: entry.location_id,
      memo: entry.memo,
      lines: lines.map((line) => ({ skuId: line.sku_id, qty: line.qty })),
    };
  }

  // --- views ----------------------------------------------------------------------------

  private async view(
    tx: Tx,
    context: ActiveContext,
    request: object,
    entryId: string,
    withCost: boolean,
  ) {
    const entry = await repo.entryById(tx, context.orgId, entryId);
    if (entry === undefined) {
      throw new StockError('STOCK_IN_HAND_NOT_FOUND', 'No such stock-in-hand entry.');
    }
    assertInScope(request, { branchId: entry.branch_id });
    const lines = await repo.linesOf(tx, context.orgId, entryId);
    const skus = await this.catalog.stickerData(
      tx,
      context.orgId,
      lines.map((line) => line.sku_id),
    );
    const bySku = new Map(skus.map((sku) => [sku.skuId, sku]));
    const locations = await this.locationNames(tx, context.orgId, [entry.location_id]);
    const total = lines.every((line) => line.unit_cost_poisha !== null)
      ? lines
          .reduce((sum, line) => sum + BigInt(line.unit_cost_poisha ?? '0') * BigInt(line.qty), 0n)
          .toString()
      : null;
    const reversalPending =
      entry.status === 'posted' &&
      (await this.approvals.hasPending(
        context,
        { type: 'stock_in_hand_reversal', payloadKey: 'entryId', value: entry.id },
        tx,
      ));

    return {
      id: entry.id,
      status: entry.status,
      locationId: entry.location_id,
      locationName: locations.get(entry.location_id) ?? '',
      branchId: entry.branch_id,
      memo: entry.memo,
      businessDate: entry.business_date,
      journalId: entry.journal_id,
      createdBy: entry.created_by,
      createdAt: entry.created_at,
      postedBy: entry.posted_by,
      postedAt: entry.posted_at,
      reversalJournalId: entry.reversal_journal_id,
      reversedBy: entry.reversed_by,
      reversedAt: entry.reversed_at,
      reversalPending,
      costWithheld: !withCost,
      ...(withCost ? { stockValuePoisha: total } : {}),
      lines: lines.map((line) => {
        const sku = bySku.get(line.sku_id);
        return {
          skuId: line.sku_id,
          skuCode: sku?.skuCode ?? '',
          barcode: sku?.barcode ?? null,
          productName: sku?.productName ?? '',
          variantLabel: sku?.variantLabel ?? '',
          qty: line.qty,
          ...(withCost ? { unitCostPoisha: line.unit_cost_poisha } : {}),
        };
      }),
    };
  }

  private async locationNames(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const names = new Map<string, string>();
    for (const id of unique) {
      const row = await stockRepo.locationById(tx, orgId, id);
      if (row !== undefined) names.set(id, row.name);
    }
    return names;
  }
}
