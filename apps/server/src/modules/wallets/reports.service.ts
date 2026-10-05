import { Injectable } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import {
  ageOpenItems,
  aggregateBalanceOf,
  COST_SUBTYPES,
  toIsoDate,
  type PartyMovement,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';

import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './wallets.repository.js';

/**
 * The reports M08 adds on top of M03's day book, cash book and trial balance
 * (architecture §7 "Reports"): P&L by org and by branch, the balance sheet,
 * payable and receivable aging. Nothing here reads across brands (D-471).
 *
 * Every number is a sum over `ledger.journal_lines`. Nothing here reads a
 * maintained total, which is why the cash book and the ledger cannot disagree
 * (M08 check 1) and why these reports cannot disagree with either.
 *
 * Two filters apply to all of them, as they do to M03's:
 *
 * - **Row scope** (§6, D-061): `LedgerReport` is `branch` for a branch manager, so
 *   lines are filtered by their own `branch_id`. A branch P&L is therefore the
 *   branch's lines, not the org's divided up.
 * - **Cost** (invariant 5, D-085): the *balance* of an inventory or COGS account is
 *   cost information whatever the field is called, so a caller without `read:cost`
 *   gets no row for those subtypes and a `costWithheld` flag instead. §6's cell for
 *   a branch manager is exactly this — "branch P&L without cost detail".
 *   `serializeFor` cannot do it, because it strips fields by name and this is a
 *   question about which rows exist.
 */

const money = (value: bigint): string => value.toString();

function costBlind(context: ActiveContext): boolean {
  return !canReadCost(context.roles, context.isSuperAdmin);
}

/**
 * One account's row in a report section.
 *
 * Exported because the controller's return types name it, and an inferred
 * return type that mentions a private interface is a compile error (TS4053)
 * rather than an implicit `any` — so this has to be public for the module to
 * build at all.
 */
export interface LineTotals {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly amountPoisha: string;
}

@Injectable()
export class WalletReportsService {
  /**
   * Profit and loss over a range of business dates, for the org or one branch.
   *
   * Income and expense are **flows**, so the range is the movement within it
   * rather than a position as of a date — which is why this cannot be assembled
   * from two balance sheets without also knowing the distributions in between.
   *
   * A caller without `read:cost` sees revenue and operating expenses and no COGS,
   * so the figure returned as `netPoisha` is not gross profit and is not labelled
   * as it: `costWithheld` says which. Reporting a net that silently excluded cost
   * of sales as "profit" would be a number a branch manager could act on and be
   * wrong by the whole margin.
   */
  async profitAndLoss(
    context: ActiveContext,
    request: object,
    range: { readonly from: string; readonly to: string; readonly branchId?: string | undefined },
  ) {
    const lineScope = this.lineScope(request, range.branchId);
    const withheld = costBlind(context);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.movementsInRange(tx, context.orgId, range, {
        lineScope,
        classes: ['income', 'expense'],
      });
      const visible = rows.filter(
        (row) => !withheld || !COST_SUBTYPES.includes(row.subtype as never),
      );

      const income: LineTotals[] = [];
      const expense: LineTotals[] = [];
      let incomeTotal = 0n;
      let expenseTotal = 0n;

      for (const row of visible) {
        // On the account's normal side: a contra-revenue account like sales
        // discounts is debit-normal, so its balance is positive when discounts
        // were given and it *reduces* income when added to the rest.
        const balance = aggregateBalanceOf(
          row.normal_balance,
          BigInt(row.debit_poisha),
          BigInt(row.credit_poisha),
        );
        const entry: LineTotals = {
          accountId: row.account_id,
          code: row.code,
          name: row.name,
          subtype: row.subtype,
          amountPoisha: money(balance),
        };
        if (row.class === 'income') {
          income.push(entry);
          incomeTotal += row.subtype === 'sales_discounts' ? -balance : balance;
        } else {
          expense.push(entry);
          expenseTotal += balance;
        }
      }

      return {
        from: range.from,
        to: range.to,
        branchId: range.branchId ?? null,
        income,
        expense,
        incomePoisha: money(incomeTotal),
        expensePoisha: money(expenseTotal),
        netPoisha: money(incomeTotal - expenseTotal),
        costWithheld: withheld,
      };
    });
  }

  /**
   * The balance sheet as of a business date.
   *
   * Assets = liabilities + equity + the result so far, and the result so far is
   * included rather than assumed to have been closed out: this product closes
   * periods monthly but never posts a year-end transfer to retained earnings
   * (§7 has no such rule), so without it the sheet would be out by every taka the
   * business has ever earned.
   *
   * It does not balance for a caller without `read:cost`, and it says so instead
   * of hiding it: inventory is the largest asset in this business and it is a cost
   * subtype, so the difference *is* the withheld information. A report that
   * silently forced the two sides equal would be inventing a number.
   */
  async balanceSheet(
    context: ActiveContext,
    request: object,
    query: { readonly asOf: string; readonly branchId?: string | undefined },
  ) {
    const lineScope = this.lineScope(request, query.branchId);
    const withheld = costBlind(context);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.positionsAsOf(tx, context.orgId, query.asOf, {
        lineScope,
        classes: ['asset', 'liability', 'equity', 'income', 'expense'],
      });
      const visible = rows.filter(
        (row) => !withheld || !COST_SUBTYPES.includes(row.subtype as never),
      );

      const sections: Record<string, LineTotals[]> = { asset: [], liability: [], equity: [] };
      const totals: Record<string, bigint> = { asset: 0n, liability: 0n, equity: 0n };
      let result = 0n;

      for (const row of visible) {
        const balance = aggregateBalanceOf(
          row.normal_balance,
          BigInt(row.debit_poisha),
          BigInt(row.credit_poisha),
        );
        if (row.class === 'income') {
          result += row.subtype === 'sales_discounts' ? -balance : balance;
          continue;
        }
        if (row.class === 'expense') {
          result -= balance;
          continue;
        }
        sections[row.class]?.push({
          accountId: row.account_id,
          code: row.code,
          name: row.name,
          subtype: row.subtype,
          amountPoisha: money(balance),
        });
        totals[row.class] = (totals[row.class] ?? 0n) + balance;
      }

      const assets = totals.asset ?? 0n;
      const funding = (totals.liability ?? 0n) + (totals.equity ?? 0n) + result;

      return {
        asOf: query.asOf,
        branchId: query.branchId ?? null,
        assets: sections.asset ?? [],
        liabilities: sections.liability ?? [],
        equity: sections.equity ?? [],
        assetsPoisha: money(assets),
        liabilitiesPoisha: money(totals.liability ?? 0n),
        equityPoisha: money(totals.equity ?? 0n),
        /** Income less expenses to date: not yet transferred to retained earnings. */
        resultPoisha: money(result),
        /** Zero for a caller who can see every account. Non-zero means cost was withheld. */
        differencePoisha: money(assets - funding),
        costWithheld: withheld,
      };
    });
  }

  /**
   * Payables or receivables by party, in §7's buckets: 0–7, 8–30, 31–60, 60+ days.
   *
   * §7 gives the boundaries. What a bucket holds is decided by D-193: the amount
   * still open, aged from the day it became owed. Each party's days are netted and
   * a settlement clears the oldest open amount first (`ageOpenItems` in the
   * domain); money paid ahead of anything owed is `unappliedPoisha`, never aged.
   * So the buckets less the unapplied amount are the party's balance — the same
   * figure the trial balance shows for that party, because both are sums over the
   * same lines.
   *
   * Supplier balances are a protected field in §6 whatever account they sit on, so
   * a caller without `read:cost` gets no supplier rows at all.
   */
  async aging(
    context: ActiveContext,
    request: object,
    query: { readonly asOf: string; readonly side: 'payable' | 'receivable' },
  ) {
    const lineScope = scopeWhere(request, { branchId: sql`l.branch_id` });
    const blind = costBlind(context);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.agingAsOf(tx, context.orgId, query.asOf, {
        lineScope,
        classes: query.side === 'payable' ? ['liability'] : ['asset'],
        excludePartyTypes: blind ? ['supplier'] : [],
      });

      // One party's days, on the side the report is for: a payable grows by a
      // credit, a receivable by a debit, and `aggregateBalanceOf` says which.
      const parties = new Map<
        string,
        { partyType: string; partyId: string; movements: PartyMovement[] }
      >();

      for (const row of rows) {
        if (blind && COST_SUBTYPES.includes(row.subtype as never)) continue;
        const key = `${row.party_type}:${row.party_id}`;
        const party = parties.get(key) ?? {
          partyType: row.party_type,
          partyId: row.party_id,
          movements: [],
        };
        const change = aggregateBalanceOf(
          row.normal_balance,
          BigInt(row.debit_poisha),
          BigInt(row.credit_poisha),
        );
        party.movements.push({
          businessDate: toIsoDate(row.business_date),
          // Plain sums of posted lines: a report never re-checks them against the
          // single-amount bound, which only a new journal line has to meet.
          increasePoisha: change > 0n ? change : 0n,
          decreasePoisha: change < 0n ? -change : 0n,
        });
        parties.set(key, party);
      }

      const asOf = toIsoDate(query.asOf);
      return {
        asOf: query.asOf,
        side: query.side,
        costWithheld: blind,
        items: [...parties.values()]
          .map((party) => ({ party, aged: ageOpenItems(party.movements, asOf) }))
          // A party whose account has come back to zero owes nothing and is owed
          // nothing; listing it would bury the ones that do.
          .filter(({ aged }) => aged.balancePoisha !== 0n)
          .map(({ party, aged }) => ({
            partyType: party.partyType,
            partyId: party.partyId,
            bucket0to7Poisha: money(aged.buckets['0-7']),
            bucket8to30Poisha: money(aged.buckets['8-30']),
            bucket31to60Poisha: money(aged.buckets['31-60']),
            bucketOver60Poisha: money(aged.buckets['60+']),
            unappliedPoisha: money(aged.unappliedPoisha),
            totalPoisha: money(aged.balancePoisha),
          })),
      };
    });
  }

  /**
   * A branch filter on top of the caller's own scope, never instead of it.
   *
   * An org-wide caller asking for one branch gets that branch; a branch manager
   * asking for another branch gets their own scope ANDed with it, which is empty.
   * Replacing the scope with the requested branch is the bug this shape avoids.
   */
  private lineScope(request: object, branchId: string | undefined) {
    const scope = scopeWhere(request, { branchId: sql`l.branch_id` });
    if (branchId === undefined) return scope;
    return sql`(${scope} and l.branch_id = ${branchId}::uuid)`;
  }
}
