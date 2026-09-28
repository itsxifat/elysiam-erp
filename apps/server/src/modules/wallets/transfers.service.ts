import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  isAccountSubtype,
  poisha,
  walletTransferDraft,
  type AccountSubtype,
} from '@elysium/domain';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import * as repo from './wallets.repository.js';
import { walletsHttpError } from './wallets.errors.js';
import type { WalletTransferInput } from './wallets.schemas.js';

/**
 * Moving money between the org's own wallets (architecture §7: **Dr W2 + Dr Bank
 * charges / Cr W1**).
 *
 * The charge is the reason this has its own service rather than being two cash
 * entries. As two entries it would be a cash out of one wallet and a cash in to
 * the other, with the charge folded into whichever side the person remembered —
 * two journals for one event, no way to tell they belonged together, and a bank
 * charge that lands in income or nowhere. One journal of three lines says what
 * happened.
 *
 * Both wallets must be in the caller's scope. A branch manager banking their own
 * till needs `update Wallet` on the till *and* on the bank account, and §6 gives
 * them neither for another branch — so the transfer that would move a showroom's
 * cash into a wallet they cannot see is refused at the row rather than the guard.
 */
@Injectable()
export class TransfersService {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly audit: AuditService,
  ) {}

  async transfer(
    context: ActiveContext,
    request: AuditableRequest,
    input: WalletTransferInput,
    now: Date = new Date(),
  ) {
    const amount = poisha(input.amountPoisha);
    const charge = poisha(input.chargePoisha);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const from = await this.walletFor(tx, context, request, input.fromWalletId);
      const to = await this.walletFor(tx, context, request, input.toWalletId);

      const chargeAccount =
        input.chargeAccountId === undefined
          ? null
          : await this.chargeAccountFor(tx, context, input.chargeAccountId);

      // A retried submit answers from the transfer that exists. Transfers are
      // append-only (0028), so there is nothing to reconcile: either the row is
      // there with its journal or it is not.
      const existing = await repo.transferById(tx, context.orgId, input.transferId);
      if (existing !== undefined) {
        /*
         * A replay is answered from the stored row, and only if it is the same transfer.
         *
         * Echoing the request's own amount back made a retry that changed the numbers
         * look like it had succeeded: `{transferId: T, amountPoisha: '5000'}` then
         * `{transferId: T, amountPoisha: '900000'}` answered `created: false` with the
         * second amount and the first journal's id — telling the operator ৳9,000 had
         * moved between wallets when ৳50 had. Nothing in the ledger was wrong; the
         * confirmation was. Both siblings already get this right (`cash.service.ts`,
         * `payments.service.ts`), and this now matches them.
         */
        const same =
          existing.from_wallet_id === from.id &&
          existing.to_wallet_id === to.id &&
          BigInt(existing.amount_poisha) === amount &&
          BigInt(existing.charge_poisha) === charge;
        if (!same) {
          throw walletsHttpError(
            'IDEMPOTENCY_CONFLICT',
            'That transfer id was already used for a different transfer.',
          );
        }
        return {
          transferId: existing.id,
          journalId: existing.journal_id,
          created: false,
          businessDate: existing.business_date,
          amountPoisha: existing.amount_poisha,
          chargePoisha: existing.charge_poisha,
        };
      }

      const draft = walletTransferDraft({
        transferId: input.transferId,
        occurredAt: now,
        from: {
          walletId: from.id,
          accountId: from.ledger_account_id,
          subtype: from.subtype as AccountSubtype,
          branchId: from.branch_id,
        },
        to: {
          walletId: to.id,
          accountId: to.ledger_account_id,
          subtype: to.subtype as AccountSubtype,
          branchId: to.branch_id,
        },
        amountPoisha: amount,
        chargePoisha: charge,
        charge:
          chargeAccount === null
            ? null
            : {
                accountId: chargeAccount.id,
                subtype: chargeAccount.subtype as AccountSubtype,
                branchId: chargeAccount.branch_id,
              },
        memo: input.memo ?? null,
      });

      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        draft,
      );

      await repo.insertTransfer(tx, {
        orgId: context.orgId,
        id: input.transferId,
        fromWalletId: from.id,
        toWalletId: to.id,
        amountPoisha: amount,
        chargePoisha: charge,
        chargeAccountId: chargeAccount?.id ?? null,
        occurredAt: now,
        businessDate: posted.businessDate,
        memo: input.memo ?? null,
        journalId: posted.journalId,
        createdBy: context.userId,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'wallets.transfer',
        entityType: 'WalletTransfer',
        entityId: input.transferId,
        before: null,
        after: {
          fromWalletId: from.id,
          toWalletId: to.id,
          amountPoisha: amount.toString(),
          chargePoisha: charge.toString(),
          journalId: posted.journalId,
          businessDate: posted.businessDate,
        },
        requestId: context.requestId,
        request,
      });

      return {
        transferId: input.transferId,
        journalId: posted.journalId,
        created: posted.created,
        businessDate: posted.businessDate,
        amountPoisha: amount.toString(),
        chargePoisha: charge.toString(),
      };
    });
  }

  private async walletFor(
    tx: Tx,
    context: ActiveContext,
    request: object,
    walletId: string,
  ): Promise<repo.WalletRow> {
    const wallet = await repo.walletById(tx, context.orgId, walletId);
    if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
      throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
    }
    try {
      assertInScope(request, { branchId: wallet.branch_id });
    } catch {
      // Out of scope answers as missing: any other answer lets a branch manager
      // discover which wallets other branches keep.
      throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
    }
    if (!wallet.is_active) throw walletsHttpError('WALLET_INACTIVE', 'That wallet is closed.');
    return wallet;
  }

  private async chargeAccountFor(
    tx: Tx,
    context: ActiveContext,
    accountId: string,
  ): Promise<repo.CategoryRow> {
    const account = await repo.accountById(tx, context.orgId, accountId);
    if (account === undefined || !isAccountSubtype(account.subtype)) {
      throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such charge account.');
    }
    // The posting rule refuses anything but `bank_charges` too; this fails first
    // with the account's code in the message, which is what a person needs.
    if (account.subtype !== 'bank_charges') {
      throw walletsHttpError(
        'LEDGER_ACCOUNT_INVALID',
        `A transfer charge posts to bank charges; ${account.code} is a ${account.subtype} account.`,
      );
    }
    return account;
  }
}
