import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  businessDate,
  canonicalDraft,
  isAccountSubtype,
  periodOf,
  poisha,
  reverseDraft,
  validateJournalDraft,
  type AccountSubtype,
  type JournalDraft,
  type JournalLineDraft,
  type PartyType,
  type PostingAccount,
} from '@elysium/domain';

import { sql } from 'drizzle-orm';

import type {
  AccountPartyBalance,
  JournalLineView,
  LedgerActor,
  LedgerApi,
  PostResult,
  WalletAccount,
  WalletChoice,
} from './ledger.api.js';
import { ledgerHttpError } from './ledger.errors.js';
import * as repo from './ledger.repository.js';

/** The subtypes `repo.walletAccountById` accepts: what a module may pay out of. */
const WALLET_SUBTYPES: readonly string[] = [
  'wallet_cash',
  'wallet_bank',
  'wallet_bkash',
  'wallet_mfs_other',
];

/**
 * `ledger.post` and `ledger.reverse` (architecture §7).
 *
 * The only writer of journals. Everything it checks, the database checks
 * again (migration 0014) — this layer exists to refuse early with a useful
 * error code rather than a constraint name, and to make replays idempotent.
 */
@Injectable()
export class LedgerService implements LedgerApi {
  async post(tx: Tx, actor: LedgerActor, draft: JournalDraft): Promise<PostResult> {
    validateJournalDraft(draft);
    const contentHash = createHash('sha256').update(canonicalDraft(draft)).digest('hex');

    // A replay answers from what is already there, before anything else is
    // checked: the period may have closed since, and a retried delivery must
    // still get its journal back rather than PERIOD_CLOSED.
    const existing = await repo.journalIdByKey(tx, actor.orgId, draft.idempotencyKey);
    if (existing !== undefined) return this.replayed(existing, contentHash, draft);

    await this.assertAccounts(tx, actor.orgId, draft.lines);

    const period = periodOf(draft.businessDate);
    if (await repo.closedPeriodFor(tx, actor.orgId, period.startsOn)) {
      throw ledgerHttpError(
        'PERIOD_CLOSED',
        `${draft.businessDate} falls in or before a closed month (from ${period.month} on).`,
      );
    }

    const journalId = await repo.insertJournal(tx, {
      orgId: actor.orgId,
      businessDate: draft.businessDate,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
      idempotencyKey: draft.idempotencyKey,
      memo: draft.memo,
      reversesJournalId: draft.reversesJournalId,
      contentHash,
      createdBy: actor.userId,
    });

    if (journalId === undefined) {
      // A concurrent post of the same key committed while this one waited on
      // the unique index. Its journal is now visible; answer with it.
      const raced = await repo.journalIdByKey(tx, actor.orgId, draft.idempotencyKey);
      if (raced === undefined) {
        throw ledgerHttpError('IDEMPOTENCY_CONFLICT', 'That key is being posted concurrently.');
      }
      return this.replayed(raced, contentHash, draft);
    }

    await repo.insertLines(
      tx,
      actor.orgId,
      journalId,
      draft.lines.map((line) => ({
        accountId: line.accountId,
        branchId: line.branchId,
        partyType: line.partyType,
        partyId: line.partyId,
        debitPoisha: line.debitPoisha,
        creditPoisha: line.creditPoisha,
        memo: line.memo,
      })),
    );

    return { journalId, created: true, businessDate: draft.businessDate };
  }

  async reverse(
    tx: Tx,
    actor: LedgerActor,
    journalId: string,
    reason: string,
    at: Date = new Date(),
  ): Promise<PostResult> {
    const journal = await repo.journalById(tx, actor.orgId, journalId);
    if (journal === undefined) throw ledgerHttpError('JOURNAL_NOT_FOUND', 'No such journal.');

    const already = await repo.reversalOf(tx, actor.orgId, journalId);
    if (already !== undefined) {
      const reversal = await repo.journalById(tx, actor.orgId, already);
      return {
        journalId: already,
        created: false,
        businessDate: reversal?.business_date ?? '',
      };
    }

    const lines = await repo.linesOfJournals(tx, actor.orgId, [journalId]);
    const draft = reverseDraft(
      {
        id: journal.id,
        reversesJournalId: journal.reverses_journal_id,
        lines: lines.map((line): JournalLineDraft => ({
          accountId: line.account_id,
          debitPoisha: poisha(line.debit_poisha),
          creditPoisha: poisha(line.credit_poisha),
          branchId: line.branch_id,
          partyType: line.party_type as PartyType | null,
          partyId: line.party_id,
          memo: line.memo,
        })),
      },
      { businessDate: businessDate(at), reason },
    );

    return this.post(tx, actor, draft);
  }

  private replayed(
    existing: { id: string; content_hash: string },
    contentHash: string,
    draft: JournalDraft,
  ): PostResult {
    if (existing.content_hash !== contentHash) {
      throw ledgerHttpError(
        'IDEMPOTENCY_CONFLICT',
        `${draft.idempotencyKey} was already posted with different content.`,
      );
    }
    return { journalId: existing.id, created: false, businessDate: draft.businessDate };
  }

  async accountBySubtype(
    tx: Tx,
    orgId: string,
    subtype: AccountSubtype,
  ): Promise<PostingAccount | null> {
    const row = await repo.accountBySubtype(tx, orgId, subtype);
    if (row === undefined || !isAccountSubtype(row.subtype)) return null;
    return { accountId: row.id, subtype: row.subtype, branchId: row.branch_id };
  }

  async walletAccountById(tx: Tx, orgId: string, id: string): Promise<WalletAccount | null> {
    const row = await repo.walletAccountById(tx, orgId, id);
    if (row === undefined || !isAccountSubtype(row.subtype)) return null;
    return {
      accountId: row.id,
      subtype: row.subtype,
      branchId: row.branch_id,
      isActive: row.is_active,
    };
  }

  async activeWallets(tx: Tx, orgId: string): Promise<readonly WalletChoice[]> {
    // `walletAccountById`'s four subtypes and its `is_active`, so the two cannot disagree.
    const rows = await repo.listAccounts(tx, orgId, {
      scope: sql`a.is_active`,
      excludeSubtypes: [],
      walletsOnly: true,
    });
    return rows
      .filter((row) => WALLET_SUBTYPES.includes(row.subtype))
      .map((row) => ({ accountId: row.id, name: row.name }));
  }

  /**
   * The same aggregate the party-balances report reads, narrowed to one subtype.
   *
   * Through `repo.partyBalances` rather than a second query of its own: the report and
   * the COD reconciliation would otherwise be two pieces of arithmetic over the same
   * rows, and the first time one of them learned to exclude something — a reversal, a
   * branch, a party type — a courier's statement and the ledger's own report would
   * disagree with nobody able to say which was right.
   *
   * `lineScope` is `true` here and no subtype is excluded, deliberately: this is a
   * server-side posting input, not a screen, so §6's branch narrowing and the
   * cost-hiding exclusions the report applies would only make the receivable smaller
   * than the money actually outstanding.
   */
  async courierReceivables(
    tx: Tx,
    orgId: string,
    asOf: string,
  ): Promise<ReadonlyMap<string, bigint>> {
    const rows = await repo.partyBalances(tx, orgId, {
      asOf,
      partyType: 'courier',
      partyId: undefined,
      lineScope: sql`true`,
      excludeSubtypes: [],
      excludePartyTypes: [],
    });

    const totals = new Map<string, bigint>();
    for (const row of rows) {
      if (row.subtype !== 'courier_receivable') continue;
      const net = BigInt(row.debit_poisha) - BigInt(row.credit_poisha);
      totals.set(row.party_id, (totals.get(row.party_id) ?? 0n) + net);
    }
    return totals;
  }

  async journalLines(
    tx: Tx,
    orgId: string,
    journalId: string,
  ): Promise<readonly JournalLineView[]> {
    const rows = await repo.linesOfJournals(tx, orgId, [journalId]);
    return rows.map((row) => ({
      accountId: row.account_id,
      subtype: row.subtype,
      partyType: row.party_type,
      partyId: row.party_id,
      debitPoisha: BigInt(row.debit_poisha),
      creditPoisha: BigInt(row.credit_poisha),
    }));
  }

  async balancesAsOf(
    tx: Tx,
    orgId: string,
    asOf: string,
    subtypes: readonly AccountSubtype[],
  ): Promise<readonly AccountPartyBalance[]> {
    const rows = await repo.balancesByAccountAndParty(tx, orgId, asOf, subtypes);
    return rows.map((row) => ({
      accountId: row.account_id,
      subtype: row.subtype,
      partyId: row.party_id,
      debitPoisha: BigInt(row.debit_poisha),
      creditPoisha: BigInt(row.credit_poisha),
    }));
  }

  /**
   * Every account exists in this org, is active, and agrees with its line on
   * party and branch. The database refuses the same things; this says which.
   */
  private async assertAccounts(
    tx: Tx,
    orgId: string,
    lines: readonly JournalLineDraft[],
  ): Promise<void> {
    const ids = [...new Set(lines.map((line) => line.accountId.toLowerCase()))];
    const accounts = new Map(
      (await repo.accountsByIds(tx, orgId, ids)).map((account) => [account.id, account]),
    );

    lines.forEach((line, index) => {
      const where = `Line ${String(index + 1)}`;
      const account = accounts.get(line.accountId.toLowerCase());
      if (account === undefined) {
        throw ledgerHttpError('LEDGER_ACCOUNT_INVALID', `${where}: no such account.`);
      }
      if (!account.is_active || !isAccountSubtype(account.subtype)) {
        throw ledgerHttpError(
          'LEDGER_ACCOUNT_INVALID',
          `${where}: account ${account.code} is inactive.`,
        );
      }
      if ((account.party_type ?? null) !== line.partyType) {
        throw ledgerHttpError(
          'JOURNAL_LINE_INVALID',
          `${where}: account ${account.code} takes party ${account.party_type ?? 'none'}.`,
        );
      }
      if (account.branch_id !== null && account.branch_id !== line.branchId?.toLowerCase()) {
        throw ledgerHttpError(
          'JOURNAL_LINE_INVALID',
          `${where}: account ${account.code} belongs to one branch; the line must name it.`,
        );
      }
    });
  }
}
