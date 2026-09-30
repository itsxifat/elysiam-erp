import { Inject, Injectable } from '@nestjs/common';
import { deterministicUuid, withOrg } from '@elysium/db';
import { businessDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import {
  POS_WALLET_CLOSING,
  type WalletClosingPort,
  type WalletClosingResult,
} from './ports/wallet-closing.port.js';
import { posHttpError } from './pos.errors.js';
import * as repo from './pos.repository.js';
import type { BranchClosingInput } from './pos.schemas.js';
import { registerView } from './registers.service.js';

/** The namespace a branch closing's per-wallet M08 closing ids are derived in. */
const WALLET_CLOSING_NAMESPACE = 'elysium-erp/pos/branch-closing-wallet';

/**
 * Branch dashboards and the branch day close (D-014; architecture §14).
 *
 * **D-014: a branch manager sees revenue and expenses, never cost.** The summary
 * carries `cogsPoisha` and `grossProfitPoisha` for the roles that hold `read:cost`;
 * both names are in `COST_FIELDS`, so `serializeFor` strips them for everyone else
 * on the way out. The P&L beside it on the dashboard is M08's own report with
 * `branchId`, which withholds cost-bearing accounts the same way — this module does
 * not compute a second P&L.
 *
 * **The day close is M08's closing, per wallet, behind a readiness gate.** What a
 * branch adds is the gate (no till still trading, no held sale still waiting) and
 * the snapshot of the day's till figures; the count, the derived expectation and
 * the `closing_variance` approval are `ClosingsService`'s, reached through a port.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly audit: AuditService,
    @Inject(WALLETS_API) private readonly wallets: WalletsApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(POS_WALLET_CLOSING) private readonly walletClosings: WalletClosingPort,
  ) {}

  async list(context: ActiveContext, request: object, date: string | undefined) {
    const scope = scopeWhere(request, { branchId: sql`b.id` });
    const day = date ?? businessDate(new Date());
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.branches(tx, context.orgId, scope);
      const items = [];
      for (const branch of rows) {
        const summary = await repo.branchSummary(tx, context.orgId, branch.id, {
          from: day,
          to: day,
        });
        items.push({
          id: branch.id,
          code: branch.code,
          name: branch.name,
          kind: branch.kind,
          businessDate: day,
          salesCount: summary.sales_count,
          netSalesPoisha: summary.net_poisha,
          refundsPoisha: summary.refunds_poisha,
          openShifts: summary.open_shifts,
          openReviews: summary.open_reviews,
          closed: (await repo.branchClosing(tx, context.orgId, branch.id, day)) !== undefined,
        });
      }
      return { items };
    });
  }

  async summary(
    context: ActiveContext,
    request: object,
    branchId: string,
    range: { from: string; to: string },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const branch = await repo.branchById(tx, context.orgId, branchId);
      if (branch === undefined) throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such branch.');
      try {
        assertInScope(request, { branchId: branch.id });
      } catch {
        throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such branch.');
      }
      const summary = await repo.branchSummary(tx, context.orgId, branch.id, range);
      const top = await repo.topSkus(tx, context.orgId, branch.id, range);
      const labels = new Map(
        (
          await this.catalog.skusByIds(
            tx,
            context.orgId,
            top.map((row) => row.sku_id),
          )
        ).map((sku) => [sku.id, sku]),
      );
      const registers = await repo.registers(tx, context.orgId, sql`r.branch_id = ${branch.id}`);
      const netRevenue = BigInt(summary.net_poisha) - BigInt(summary.refunds_poisha);
      const netCogs = BigInt(summary.cogs_poisha) - BigInt(summary.return_cogs_poisha);
      return {
        branch: { id: branch.id, code: branch.code, name: branch.name, kind: branch.kind },
        range,
        salesCount: summary.sales_count,
        heldCount: summary.held_count,
        grossPoisha: summary.gross_poisha,
        discountPoisha: summary.discount_poisha,
        netSalesPoisha: summary.net_poisha,
        returnsCount: summary.returns_count,
        refundsPoisha: summary.refunds_poisha,
        netRevenuePoisha: netRevenue.toString(),
        averageBasketPoisha:
          summary.sales_count === 0
            ? '0'
            : (BigInt(summary.net_poisha) / BigInt(summary.sales_count)).toString(),
        tenders: {
          cashPoisha: summary.cash_poisha,
          bkashPoisha: summary.bkash_poisha,
          cardPoisha: summary.card_poisha,
        },
        // Cost fields: stripped by `serializeFor` for roles without `read:cost` (D-014).
        cogsPoisha: netCogs.toString(),
        grossProfitPoisha: (netRevenue - netCogs).toString(),
        openShifts: summary.open_shifts,
        openReviews: summary.open_reviews,
        topSkus: top.map((row) => ({
          skuId: row.sku_id,
          skuCode: labels.get(row.sku_id)?.code ?? '',
          name: labels.get(row.sku_id)?.productName ?? '',
          qty: row.qty,
          netPoisha: row.net_poisha,
        })),
        registers: registers.map(registerView),
      };
    });
  }

  /**
   * Close a branch's business day: every till counted, M08's closing per wallet.
   *
   * Refused while a shift on or before that day is still open — you cannot count a
   * drawer that is still trading — or while a held sale or return of that day is
   * unresolved: its cash is in the till but not in the ledger, so M08's derived
   * expectation would be short by exactly that sale and the variance approval would
   * be asked to explain a number that is not a variance at all.
   *
   * Idempotent per `closingId`, and each wallet's M08 closing id is derived from it,
   * so a retry after a dropped reply re-reaches the same closings rather than
   * counting the till twice.
   */
  async close(
    context: ActiveContext,
    request: AuditableRequest,
    branchId: string,
    input: BranchClosingInput,
  ) {
    assertInScope(request, { branchId });
    if (input.businessDate > businessDate(new Date())) {
      throw posHttpError(
        'POS_BRANCH_DAY_NOT_READY',
        'A day is closed once it has begun, not before.',
      );
    }

    const plan = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const branch = await repo.branchById(tx, context.orgId, branchId);
      if (branch === undefined) throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such branch.');

      const existing = await repo.branchClosing(tx, context.orgId, branchId, input.businessDate);
      if (existing !== undefined && existing.id !== input.closingId) {
        throw posHttpError('CLOSING_ALREADY_RECORDED', 'This branch day is already closed.');
      }

      const ready = await repo.branchReadiness(tx, context.orgId, branchId, input.businessDate);
      if (existing === undefined && (ready.open_shifts > 0 || ready.open_reviews > 0)) {
        throw posHttpError(
          'POS_BRANCH_DAY_NOT_READY',
          `Close every shift (${String(ready.open_shifts)} open) and resolve every held sale ` +
            `(${String(ready.open_reviews)} waiting) before closing the day.`,
        );
      }

      // The wallets a branch counts: its registers' tender wallets that belong to
      // this branch. An org-level bank or bKash account is not a showroom's to count.
      const registers = await repo.registers(tx, context.orgId, sql`r.branch_id = ${branchId}`);
      const candidates = new Set(
        registers.flatMap((r) => [r.cash_wallet_id, r.bkash_wallet_id, r.card_wallet_id]),
      );
      const counted = new Set(input.counts.map((count) => count.walletId));
      if (counted.size !== input.counts.length) {
        throw posHttpError('POS_REGISTER_INVALID', 'Each wallet is counted once.');
      }
      for (const walletId of counted) {
        const account = candidates.has(walletId)
          ? await this.wallets.walletAccount(tx, context.orgId, walletId)
          : null;
        if (account?.branchId !== branchId) {
          throw posHttpError('POS_REGISTER_INVALID', 'Count only this branch’s own till wallets.');
        }
      }
      for (const register of registers.filter((r) => r.is_active)) {
        if (!counted.has(register.cash_wallet_id)) {
          throw posHttpError(
            'POS_BRANCH_DAY_NOT_READY',
            `Register ${register.code}'s hand cash has not been counted.`,
          );
        }
      }
      const summary = await repo.branchSummary(tx, context.orgId, branchId, {
        from: input.businessDate,
        to: input.businessDate,
      });
      return { summary, existing };
    });

    const results: WalletClosingResult[] = [];
    for (const count of input.counts) {
      results.push(
        await this.walletClosings.close(context, request, {
          closingId: deterministicUuid(
            WALLET_CLOSING_NAMESPACE,
            `${input.closingId}:${count.walletId}`,
          ),
          walletId: count.walletId,
          businessDate: input.businessDate,
          countedPoisha: count.countedPoisha,
          memo: `Branch close ${input.businessDate}`,
        }),
      );
    }

    await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      await repo.insertBranchClosing(tx, {
        orgId: context.orgId,
        id: input.closingId,
        branchId,
        businessDate: input.businessDate,
        closedBy: context.userId,
        salesCount: plan.summary.sales_count,
        netSalesPoisha: BigInt(plan.summary.net_poisha),
        refundsPoisha: BigInt(plan.summary.refunds_poisha),
        note: input.note ?? null,
        wallets: results.map((closing) => ({
          walletId: closing.walletId,
          walletClosingId: closing.closingId,
          countedPoisha: BigInt(closing.countedPoisha),
        })),
      });
      if (plan.existing === undefined) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'pos.branch_day.closed',
          entityType: 'PosBranchClosing',
          entityId: input.closingId,
          before: null,
          after: {
            branchId,
            businessDate: input.businessDate,
            wallets: results.map((closing) => ({
              walletId: closing.walletId,
              status: closing.status,
              variancePoisha: closing.variancePoisha,
            })),
          },
          requestId: context.requestId,
          request,
        });
      }
    });

    return {
      closingId: input.closingId,
      branchId,
      businessDate: input.businessDate,
      salesCount: plan.summary.sales_count,
      netSalesPoisha: plan.summary.net_poisha,
      refundsPoisha: plan.summary.refunds_poisha,
      wallets: results,
    };
  }

  async closings(
    context: ActiveContext,
    request: object,
    branchId: string,
    range: { from: string; to: string },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const branch = await repo.branchById(tx, context.orgId, branchId);
      if (branch === undefined) throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such branch.');
      try {
        assertInScope(request, { branchId });
      } catch {
        throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such branch.');
      }
      const rows = await repo.branchClosings(tx, context.orgId, branchId, range);
      return {
        items: rows.map((row) => ({
          id: row.id,
          businessDate: row.business_date,
          closedBy: row.closed_by,
          salesCount: row.sales_count,
          netSalesPoisha: row.net_sales_poisha,
          refundsPoisha: row.refunds_poisha,
          note: row.note,
          closedAt: row.created_at,
          wallets: row.wallets.map((wallet) => ({
            walletId: wallet.wallet_id,
            walletClosingId: wallet.wallet_closing_id,
            countedPoisha: wallet.counted_poisha,
          })),
        })),
      };
    });
  }
}
