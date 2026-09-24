import { Injectable } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { aggregateBalanceOf, COST_SUBTYPES, isAccountSubtype } from '@elysium/domain';
import { sql, type SQL } from 'drizzle-orm';

import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ledgerHttpError } from './ledger.errors.js';
import { assertAccountInScope } from './ledger.scope.js';
import * as repo from './ledger.repository.js';

/**
 * The ledger's read side (architecture §7 "Reports"): account ledger, trial
 * balance, party balances, cash book per wallet, and the day book.
 *
 * Two filters apply to every one of them, on top of RLS:
 *
 * - **Row scope** (§6, D-061). `LedgerReport` and `Wallet` are branch-scoped
 *   for a branch manager, so lines are filtered by their `branch_id` and a
 *   branch-level account outside the caller's branches is "not found".
 * - **Cost** (invariant 5, D-085). The balance of an inventory, COGS or
 *   supplier account *is* cost information, whatever the field is called, so
 *   a role without `read:cost` gets no row for those accounts and a
 *   `costWithheld` flag instead. `serializeFor` cannot do this — it strips
 *   fields by name — so it is done here, where the subtype is known.
 */

/** Amounts are integer-poisha strings on the wire (JSON has no bigint). */
const money = (value: bigint): string => value.toString();

/**
 * Report arithmetic is plain `bigint` (`aggregateBalanceOf`, D-079): a total
 * of stored journals is never refused, however large.
 */
const total = (values: readonly string[]): bigint =>
  values.reduce((acc, value) => acc + BigInt(value), 0n);

const MAX_LINES = 5_000;
const MAX_DAY_BOOK_JOURNALS = 2_000;
const MAX_DAY_BOOK_DAYS = 31;
const MAX_DAY_BOOK_LINES = 20_000;

function costBlind(context: ActiveContext): boolean {
  return !canReadCost(context.roles, context.isSuperAdmin);
}

function hiddenSubtypes(context: ActiveContext): readonly string[] {
  return costBlind(context) ? COST_SUBTYPES : [];
}

function normalSide(normal: 'debit' | 'credit', debit: string, credit: string): bigint {
  return aggregateBalanceOf(normal, BigInt(debit), BigInt(credit));
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

@Injectable()
export class ReportsService {
  /** The chart of accounts, as far as the caller may see it. */
  async accounts(context: ActiveContext, request: object) {
    // A branch-scoped caller sees their branch's accounts plus the org-level
    // other-income categories they post cash in against (audit N7). Names of
    // income categories are not scoped data.
    const scope = sql`(${scopeWhere(request, { branchId: sql`a.branch_id` })}
      or (a.branch_id is null and a.subtype = 'other_income'))`;
    const withheld = hiddenSubtypes(context);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listAccounts(tx, context.orgId, { scope, excludeSubtypes: withheld });
      return {
        items: rows.map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          class: row.class,
          subtype: row.subtype,
          normalBalance: row.normal_balance,
          branchId: row.branch_id,
          partyType: row.party_type,
          isSystem: row.is_system,
          isActive: row.is_active,
        })),
        costWithheld: withheld.length > 0,
      };
    });
  }

  /** Trial balance as of a business date. Nets to zero for an org-wide caller. */
  async trialBalance(context: ActiveContext, request: object, asOf: string) {
    const lineScope = scopeWhere(request, { branchId: sql`l.branch_id` });
    const withheld = hiddenSubtypes(context);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.balancesAsOf(tx, context.orgId, asOf, {
        lineScope,
        excludeSubtypes: withheld,
      });
      const totalDebit = total(rows.map((row) => row.debit_poisha));
      const totalCredit = total(rows.map((row) => row.credit_poisha));
      return {
        asOf,
        items: rows.map((row) => ({
          accountId: row.account_id,
          code: row.code,
          name: row.name,
          class: row.class,
          subtype: row.subtype,
          branchId: row.branch_id,
          debitPoisha: row.debit_poisha,
          creditPoisha: row.credit_poisha,
          balancePoisha: money(normalSide(row.normal_balance, row.debit_poisha, row.credit_poisha)),
        })),
        totalDebitPoisha: money(totalDebit),
        totalCreditPoisha: money(totalCredit),
        differencePoisha: money(totalDebit - totalCredit),
        costWithheld: withheld.length > 0,
      };
    });
  }

  /** One account's lines in a range, with opening, running and closing balances. */
  async accountLedger(
    context: ActiveContext,
    request: object,
    accountId: string,
    range: { from: string | undefined; to: string },
  ) {
    const lineScope = scopeWhere(request, { branchId: sql`l.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const [account] = await repo.accountsByIds(tx, context.orgId, [accountId]);
      if (account === undefined || this.hidden(context, account.subtype)) {
        throw ledgerHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such account.');
      }
      // A branch-level account outside the caller's branches does not exist
      // for them, rather than existing with nothing on it.
      if (account.branch_id !== null) {
        assertAccountInScope(request, { branchId: account.branch_id }, 'No such account.');
      }

      return this.statement(tx, context.orgId, account, range, lineScope);
    });
  }

  /** Wallets and their balances today, as far as the caller may see them. */
  async wallets(context: ActiveContext, request: object, asOf: string) {
    const scope = scopeWhere(request, { branchId: sql`a.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const accounts = await repo.listAccounts(tx, context.orgId, {
        scope,
        excludeSubtypes: [],
        walletsOnly: true,
      });
      const balances = new Map(
        (
          await repo.balancesAsOf(tx, context.orgId, asOf, {
            lineScope: sql`l.account_id = any (${sql.param(accounts.map((a) => a.id))}::uuid[])`,
            excludeSubtypes: [],
          })
        ).map((row) => [row.account_id, row]),
      );
      return {
        asOf,
        items: accounts.map((account) => {
          const row = balances.get(account.id);
          return {
            accountId: account.id,
            code: account.code,
            name: account.name,
            subtype: account.subtype,
            branchId: account.branch_id,
            isActive: account.is_active,
            balancePoisha: money(
              row === undefined ? 0n : normalSide('debit', row.debit_poisha, row.credit_poisha),
            ),
          };
        }),
      };
    });
  }

  /** The cash book of one wallet: its account ledger, plus what each entry was against. */
  async cashBook(
    context: ActiveContext,
    request: object,
    walletId: string,
    range: { from: string | undefined; to: string },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const [account] = await repo.accountsByIds(tx, context.orgId, [walletId]);
      if (account?.subtype.startsWith('wallet_') !== true) {
        throw ledgerHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
      }
      // Wallet scope is by the wallet's own branch: a branch manager sees
      // their branch's wallets, and an org-level wallet is not theirs.
      assertAccountInScope(request, { branchId: account.branch_id }, 'No such wallet.');

      const statement = await this.statement(tx, context.orgId, account, range, sql`true`);
      const against = await repo.counterAccounts(
        tx,
        context.orgId,
        statement.items.map((item) => item.journalId),
        account.id,
        hiddenSubtypes(context),
      );
      return {
        ...statement,
        items: statement.items.map((item) => ({
          ...item,
          // Names only, never amounts, and never a cost account's name for a
          // caller without read:cost: "against 1300 Inventory" beside the
          // cash amount is a purchase cost (audit N6, D-085).
          against: (against.get(item.journalId) ?? []).map((entry) => ({
            code: entry.code,
            name: entry.name,
          })),
        })),
      };
    });
  }

  /** Every journal in a business-date range, with the lines the caller may see. */
  async dayBook(context: ActiveContext, request: object, range: { from: string; to: string }) {
    if (daysBetween(range.from, range.to) >= MAX_DAY_BOOK_DAYS) {
      throw ledgerHttpError(
        'POSTING_INPUT_INVALID',
        `A day book covers at most ${String(MAX_DAY_BOOK_DAYS)} days.`,
      );
    }
    const lineScope = scopeWhere(request, { branchId: sql`l.branch_id` });
    const withheld = hiddenSubtypes(context);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const journals = await repo.journalsInRange(
        tx,
        context.orgId,
        range,
        { lineScope, excludeSubtypes: withheld },
        MAX_DAY_BOOK_JOURNALS + 1,
      );
      const lines = await repo.linesOfJournals(
        tx,
        context.orgId,
        journals.slice(0, MAX_DAY_BOOK_JOURNALS).map((journal) => journal.id),
        { scope: lineScope, excludeSubtypes: withheld, limit: MAX_DAY_BOOK_LINES + 1 },
      );
      // Bounded by lines as well as journals: 2,000 journals of 500 lines each
      // would be a million rows in one response (review L4). Stop at the last
      // journal whose lines all fit, and say so.
      let shown = journals.slice(0, MAX_DAY_BOOK_JOURNALS);
      let truncated = journals.length > MAX_DAY_BOOK_JOURNALS;
      if (lines.length > MAX_DAY_BOOK_LINES) {
        const cut = lines[MAX_DAY_BOOK_LINES]?.journal_id;
        const index = shown.findIndex((journal) => journal.id === cut);
        shown = shown.slice(0, Math.max(index, 0));
        truncated = true;
      }
      const byJournal = new Map<string, repo.LineRow[]>();
      for (const line of lines) {
        const list = byJournal.get(line.journal_id) ?? [];
        list.push(line);
        byJournal.set(line.journal_id, list);
      }

      return {
        from: range.from,
        to: range.to,
        truncated,
        costWithheld: withheld.length > 0,
        items: shown.map((journal) => ({
          journalId: journal.id,
          businessDate: journal.business_date,
          sourceType: journal.source_type,
          sourceId: journal.source_id,
          memo: journal.memo,
          reversesJournalId: journal.reverses_journal_id,
          createdBy: journal.created_by,
          createdAt: journal.created_at,
          lines: (byJournal.get(journal.id) ?? []).map((line) => ({
            lineNo: line.line_no,
            accountId: line.account_id,
            accountCode: line.account_code,
            accountName: line.account_name,
            branchId: line.branch_id,
            partyType: line.party_type,
            partyId: line.party_id,
            debitPoisha: line.debit_poisha,
            creditPoisha: line.credit_poisha,
            memo: line.memo,
          })),
        })),
      };
    });
  }

  /** What each party owes or is owed, per account, as of a date. */
  async partyBalances(
    context: ActiveContext,
    request: object,
    query: { asOf: string; partyType?: string | undefined; partyId?: string | undefined },
  ) {
    const lineScope = scopeWhere(request, { branchId: sql`l.branch_id` });
    const withheld = hiddenSubtypes(context);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.partyBalances(tx, context.orgId, {
        asOf: query.asOf,
        partyType: query.partyType,
        partyId: query.partyId,
        lineScope,
        excludeSubtypes: withheld,
        // Supplier balances are protected fields in §6, whatever account
        // they sit on.
        excludePartyTypes: costBlind(context) ? ['supplier'] : [],
      });
      return {
        asOf: query.asOf,
        costWithheld: withheld.length > 0,
        items: rows.map((row) => ({
          partyType: row.party_type,
          partyId: row.party_id,
          accountId: row.account_id,
          code: row.code,
          name: row.name,
          subtype: row.subtype,
          debitPoisha: row.debit_poisha,
          creditPoisha: row.credit_poisha,
          balancePoisha: money(normalSide(row.normal_balance, row.debit_poisha, row.credit_poisha)),
        })),
      };
    });
  }

  private hidden(context: ActiveContext, subtype: string): boolean {
    return hiddenSubtypes(context).includes(subtype) || !isAccountSubtype(subtype);
  }

  private async statement(
    tx: Tx,
    orgId: string,
    account: repo.AccountRow,
    range: { from: string | undefined; to: string },
    lineScope: SQL,
  ) {
    const opening = await repo.accountTotalsBefore(tx, orgId, account.id, range.from, lineScope);
    const rows = await repo.accountLines(tx, orgId, account.id, range, lineScope, MAX_LINES + 1);
    const truncated = rows.length > MAX_LINES;
    const shown = rows.slice(0, MAX_LINES);

    const openingBalance = aggregateBalanceOf(
      account.normal_balance,
      opening.debit,
      opening.credit,
    );
    let running = openingBalance;
    let debits = 0n;
    let credits = 0n;

    const items = shown.map((row) => {
      const debit = BigInt(row.debit_poisha);
      const credit = BigInt(row.credit_poisha);
      debits += debit;
      credits += credit;
      running += aggregateBalanceOf(account.normal_balance, debit, credit);
      return {
        journalId: row.journal_id,
        lineNo: row.line_no,
        businessDate: row.business_date,
        sourceType: row.source_type,
        memo: row.line_memo ?? row.journal_memo,
        branchId: row.branch_id,
        partyType: row.party_type,
        partyId: row.party_id,
        debitPoisha: row.debit_poisha,
        creditPoisha: row.credit_poisha,
        balancePoisha: money(running),
      };
    });

    return {
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        subtype: account.subtype,
        normalBalance: account.normal_balance,
        branchId: account.branch_id,
      },
      from: range.from ?? null,
      to: range.to,
      openingBalancePoisha: money(openingBalance),
      totalDebitPoisha: money(debits),
      totalCreditPoisha: money(credits),
      closingBalancePoisha: money(running),
      truncated,
      items,
    };
  }
}
