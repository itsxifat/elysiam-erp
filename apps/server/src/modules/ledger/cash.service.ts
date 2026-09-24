import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { cashInDraft, idempotencyKey, isAccountSubtype, poisha } from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { LEDGER_API, type LedgerApi } from './ledger.api.js';
import { ledgerHttpError } from './ledger.errors.js';
import * as repo from './ledger.repository.js';

/**
 * Cash in (architecture §7 posting rules: Dr W / Cr income account), end to
 * end: the one posting rule M03 ships, to prove the pipeline from an HTTP
 * request through a pure posting rule, `ledger.post`, the database's checks
 * and the audit log.
 *
 * The business date is the Asia/Dhaka date of *now* — the server's clock, not
 * the client's. Nothing here can be back-dated, which is what keeps it clear
 * of the `back_dated_entry` approval until that flow exists (D-086).
 */
@Injectable()
export class CashService {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly audit: AuditService,
  ) {}

  async cashIn(
    context: ActiveContext,
    input: {
      entryId: string;
      walletAccountId: string;
      incomeAccountId: string;
      amountPoisha: string;
      memo: string | undefined;
      request: AuditableRequest;
    },
    now: Date = new Date(),
  ) {
    const amount = poisha(input.amountPoisha);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const accounts = await repo.accountsByIds(tx, context.orgId, [
        input.walletAccountId,
        input.incomeAccountId,
      ]);
      const wallet = accounts.find((account) => account.id === input.walletAccountId.toLowerCase());
      const income = accounts.find((account) => account.id === input.incomeAccountId.toLowerCase());

      // The same answer for another org's wallet as for one that does not
      // exist: RLS has already made them the same thing.
      if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
        throw ledgerHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
      }
      // `update Wallet` is branch-scoped for a branch manager: their own
      // branch's wallets and nothing else (§6), checked before anything is
      // written.
      assertInScope(input.request, { branchId: wallet.branch_id });

      if (income === undefined || !isAccountSubtype(income.subtype)) {
        throw ledgerHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such income category.');
      }

      // A retry of an entry already posted — possibly after Dhaka midnight,
      // when a rebuilt draft would carry a new business date — is answered
      // from the journal that exists, if it says the same thing.
      const key = idempotencyKey('cash_in', input.entryId, 'received');
      const prior = await repo.journalIdByKey(tx, context.orgId, key);
      if (prior !== undefined) {
        const replayed = await this.replay(tx, context.orgId, prior.id, {
          walletId: wallet.id,
          incomeId: income.id,
          amount,
        });
        return {
          journalId: prior.id,
          created: false,
          businessDate: replayed,
          amountPoisha: amount.toString(),
          walletAccountId: wallet.id,
          incomeAccountId: income.id,
        };
      }

      const draft = cashInDraft({
        entryId: input.entryId,
        occurredAt: now,
        wallet: { accountId: wallet.id, subtype: wallet.subtype, branchId: wallet.branch_id },
        income: { accountId: income.id, subtype: income.subtype, branchId: income.branch_id },
        amountPoisha: amount,
        memo: input.memo ?? null,
      });

      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        draft,
      );

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'ledger.cash_in',
        entityType: 'Journal',
        entityId: posted.journalId,
        before: null,
        after: {
          walletAccountId: wallet.id,
          incomeAccountId: income.id,
          amountPoisha: amount.toString(),
          businessDate: posted.businessDate,
          idempotencyKey: draft.idempotencyKey,
          created: posted.created,
        },
        requestId: context.requestId,
        request: input.request,
      });

      return {
        journalId: posted.journalId,
        created: posted.created,
        businessDate: posted.businessDate,
        amountPoisha: amount.toString(),
        walletAccountId: wallet.id,
        incomeAccountId: income.id,
      };
    });
  }

  /**
   * The business date of an existing cash-in journal, if it records this
   * wallet, category and amount; IDEMPOTENCY_CONFLICT if the entry id was
   * used for something else.
   */
  private async replay(
    tx: Tx,
    orgId: string,
    journalId: string,
    expected: { walletId: string; incomeId: string; amount: bigint },
  ): Promise<string> {
    const journal = await repo.journalById(tx, orgId, journalId);
    const lines = await repo.linesOfJournals(tx, orgId, [journalId]);
    const [debit, credit] = lines;
    const same =
      journal?.source_type === 'cash_in' &&
      lines.length === 2 &&
      debit?.account_id === expected.walletId &&
      BigInt(debit.debit_poisha) === expected.amount &&
      credit?.account_id === expected.incomeId &&
      BigInt(credit.credit_poisha) === expected.amount;
    if (!same || journal === undefined) {
      throw ledgerHttpError(
        'IDEMPOTENCY_CONFLICT',
        'That entry id was already used for a different cash-in.',
      );
    }
    return journal.business_date;
  }
}
