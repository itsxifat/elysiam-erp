import { Injectable } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withAnalytics, withOrg } from '@elysium/db';
import { aggregateBalanceOf, COST_SUBTYPES } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './wallets.repository.js';
import { walletsHttpError } from './wallets.errors.js';

/**
 * The reports M08 adds on top of M03's day book, cash book and trial balance
 * (architecture §7 "Reports"): P&L by org and by branch, the balance sheet,
 * payable and receivable aging, and the Super Admin consolidated views.
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
   * §7 gives the boundaries, so they are not an assumption this milestone had to
   * make (D-120). What it did have to decide is what a bucket is measured from: the
   * business date of each **line**, because a payable in this ledger is a running
   * account rather than a list of invoices until M09 gives supplies their own
   * identity. The property that matters is that the buckets sum to the balance the
   * trial balance shows for the same party, and they do, because both are sums over
   * the same lines.
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

      interface Aged {
        partyType: string;
        partyId: string;
        buckets: Record<string, bigint>;
        totalPoisha: bigint;
      }
      const parties = new Map<string, Aged>();

      for (const row of rows) {
        if (blind && COST_SUBTYPES.includes(row.subtype as never)) continue;
        const key = `${row.party_type}:${row.party_id}`;
        const party: Aged = parties.get(key) ?? {
          partyType: row.party_type,
          partyId: row.party_id,
          buckets: { '0-7': 0n, '8-30': 0n, '31-60': 0n, '60+': 0n },
          totalPoisha: 0n,
        };
        const balance = aggregateBalanceOf(
          row.normal_balance,
          BigInt(row.debit_poisha),
          BigInt(row.credit_poisha),
        );
        party.buckets[row.bucket] = (party.buckets[row.bucket] ?? 0n) + balance;
        party.totalPoisha += balance;
        parties.set(key, party);
      }

      return {
        asOf: query.asOf,
        side: query.side,
        costWithheld: blind,
        items: [...parties.values()].map((party) => ({
          partyType: party.partyType,
          partyId: party.partyId,
          bucket0to7Poisha: money(party.buckets['0-7'] ?? 0n),
          bucket8to30Poisha: money(party.buckets['8-30'] ?? 0n),
          bucket31to60Poisha: money(party.buckets['31-60'] ?? 0n),
          bucketOver60Poisha: money(party.buckets['60+'] ?? 0n),
          totalPoisha: money(party.totalPoisha),
        })),
      };
    });
  }

  /**
   * Every brand's wallet total, in one answer, for Super Admin (M08 check 3).
   *
   * `withAnalytics()`, never `withOrg()` in a loop. §5 exception 3 allows exactly
   * this read and requires it to be read-only, and the role is what makes that
   * true: `erp_analytics` has SELECT on three ledger tables (migration 0030) and no
   * INSERT, UPDATE or DELETE on anything. The loop would produce the same numbers
   * today and leave nothing in the database to stop a write being added to it
   * tomorrow.
   *
   * Refused for anyone but a platform super admin. `read LedgerReport` is held at
   * `org` by org_admin and accounts too, so the ability alone is not the check —
   * the `all` scope is, and `isSuperAdmin` is how §5 expresses it.
   */
  async consolidatedWallets(context: ActiveContext) {
    this.assertSuperAdmin(context);

    return withAnalytics(async (tx) => {
      const rows = await repo.consolidatedWalletTotals(tx);
      const byOrg = new Map<
        string,
        { orgId: string; orgName: string; totalPoisha: bigint; bySubtype: Record<string, string> }
      >();

      for (const row of rows) {
        const balance = aggregateBalanceOf(
          'debit',
          BigInt(row.debit_poisha),
          BigInt(row.credit_poisha),
        );
        const org = byOrg.get(row.org_id) ?? {
          orgId: row.org_id,
          orgName: row.org_name,
          totalPoisha: 0n,
          bySubtype: {},
        };
        org.bySubtype[row.subtype] = money(BigInt(org.bySubtype[row.subtype] ?? '0') + balance);
        byOrg.set(row.org_id, { ...org, totalPoisha: org.totalPoisha + balance });
      }

      const orgs = [...byOrg.values()];
      return {
        orgs: orgs.map((org) => ({
          orgId: org.orgId,
          orgName: org.orgName,
          totalPoisha: money(org.totalPoisha),
          bySubtype: org.bySubtype,
        })),
        // The check the milestone measures: this equals the sum of the orgs'
        // totals, because it is computed from the same rows rather than from a
        // second query that could filter differently.
        totalPoisha: money(orgs.reduce((total, org) => total + org.totalPoisha, 0n)),
      };
    });
  }

  /** Every brand's income, expense and net over a range. Same role, same rules. */
  async consolidatedProfitAndLoss(
    context: ActiveContext,
    range: { readonly from: string; readonly to: string },
  ) {
    this.assertSuperAdmin(context);

    return withAnalytics(async (tx) => {
      const rows = await repo.consolidatedProfitAndLoss(tx, range);
      const byOrg = new Map<
        string,
        { orgId: string; orgName: string; income: bigint; expense: bigint }
      >();

      for (const row of rows) {
        const org = byOrg.get(row.org_id) ?? {
          orgId: row.org_id,
          orgName: row.org_name,
          income: 0n,
          expense: 0n,
        };
        // Income is credit-normal, expense debit-normal. `sales_discounts` is a
        // debit-normal income account, so summing income as credit − debit nets
        // the discounts off revenue exactly as the per-org P&L does.
        if (row.class === 'income') {
          org.income += BigInt(row.credit_poisha) - BigInt(row.debit_poisha);
        } else {
          org.expense += BigInt(row.debit_poisha) - BigInt(row.credit_poisha);
        }
        byOrg.set(row.org_id, org);
      }

      const orgs = [...byOrg.values()];
      return {
        from: range.from,
        to: range.to,
        orgs: orgs.map((org) => ({
          orgId: org.orgId,
          orgName: org.orgName,
          incomePoisha: money(org.income),
          expensePoisha: money(org.expense),
          netPoisha: money(org.income - org.expense),
        })),
        incomePoisha: money(orgs.reduce((total, org) => total + org.income, 0n)),
        expensePoisha: money(orgs.reduce((total, org) => total + org.expense, 0n)),
        netPoisha: money(orgs.reduce((total, org) => total + org.income - org.expense, 0n)),
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

  private assertSuperAdmin(context: ActiveContext): void {
    if (!context.isSuperAdmin) {
      throw walletsHttpError(
        'FORBIDDEN',
        'The consolidated view is the platform super admin’s (§5 exception 3).',
      );
    }
  }
}
