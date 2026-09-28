import { Inject, Injectable } from '@nestjs/common';
import { serializeFor } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { isAccountSubtype, poisha } from '@elysium/domain';
import { investorCapitalDraft } from '@elysium/domain/posting/investors';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import * as repo from './investors.repository.js';
import { investorsHttpError, mapInvestorErrors } from './investors.errors.js';
import { InvestorsService, investorScope } from './investors.service.js';
import type { RecordInvestmentInput } from './investors.schemas.js';

/**
 * Capital contributions (architecture §7 "Investor capital received", §15).
 *
 * Money coming **in**, and that is why this is the one investor movement with no
 * maker-checker: nothing is recovered by making a second person agree that an
 * investor's ৳50,00,000 arrived, and holding it unposted would leave the wallet
 * disagreeing with the bank statement until somebody clicked. The journal is the
 * record, and it is posted in the same transaction as the row.
 *
 * Two things are worth reading as decisions:
 *
 * 1. **The equity account is looked up, never named by the caller.** A request
 *    that could choose which account to credit could credit income — the mistake
 *    that balances perfectly and shows a capital injection as a profitable month.
 *    The chart is seeded from one template per org (D-084), so there is exactly
 *    one `investor_capital` account and this reads it.
 * 2. **The business date is the Asia/Dhaka date of the server's clock** at the
 *    moment of recording, not the client's (invariant 8). A contribution can
 *    therefore never be back-dated into a closed period from a screen; a genuine
 *    late entry is a `back_dated_entry` approval, which is the ledger's own
 *    mechanism and not this module's to reinvent.
 */

export interface InvestmentResult {
  readonly investmentId: string;
  readonly investorId: string;
  readonly amountPoisha: string;
  readonly businessDate: string;
  readonly journalId: string;
  readonly lockInUntil: string | null;
}

@Injectable()
export class InvestmentsService {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly investors: InvestorsService,
    private readonly audit: AuditService,
  ) {}

  async record(
    context: ActiveContext,
    request: AuditableRequest,
    input: RecordInvestmentInput,
    now: Date = new Date(),
  ): Promise<InvestmentResult> {
    const amount = poisha(input.amountPoisha);

    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const investor = await this.investors.requireInvestor(
          tx,
          context,
          request,
          input.investorId,
        );
        if (investor.status !== 'active') {
          throw investorsHttpError(
            'INVESTOR_INACTIVE',
            `${investor.code} has exited; record the contribution against a new investor.`,
          );
        }

        // A retried submit — the same client-generated id — answers from the row
        // that exists rather than posting a second journal.
        const existing = await repo.investmentById(tx, context.orgId, input.investmentId);
        if (existing !== undefined) {
          if (
            existing.investor_id !== input.investorId.toLowerCase() ||
            BigInt(existing.amount_poisha) !== amount
          ) {
            throw investorsHttpError(
              'IDEMPOTENCY_CONFLICT',
              'That contribution id was already used for a different contribution.',
            );
          }
          return this.view(existing);
        }

        const wallet = await repo.accountById(tx, context.orgId, input.walletAccountId);
        if (wallet === undefined || !isAccountSubtype(wallet.subtype)) {
          throw investorsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet account.');
        }
        if (!wallet.is_active) {
          throw investorsHttpError('LEDGER_ACCOUNT_INVALID', `${wallet.code} is inactive.`);
        }

        const capital = await repo.accountBySubtype(tx, context.orgId, 'investor_capital');
        if (capital === undefined || !isAccountSubtype(capital.subtype)) {
          throw investorsHttpError(
            'LEDGER_ACCOUNT_NOT_FOUND',
            'This organization has no investor capital account. Seed the chart of accounts first.',
          );
        }

        const draft = investorCapitalDraft({
          investmentId: input.investmentId,
          investorId: investor.id,
          occurredAt: now,
          wallet: {
            accountId: wallet.id,
            subtype: wallet.subtype,
            branchId: wallet.branch_id,
          },
          capital: {
            accountId: capital.id,
            subtype: capital.subtype,
            branchId: capital.branch_id,
          },
          amountPoisha: amount,
          memo: input.memo ?? null,
        });

        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          draft,
        );

        await repo.insertInvestment(tx, {
          orgId: context.orgId,
          id: input.investmentId,
          investorId: investor.id,
          amountPoisha: amount,
          walletAccountId: wallet.id,
          occurredAt: now,
          businessDate: posted.businessDate,
          lockInUntil: input.lockInUntil ?? null,
          terms: input.terms ?? null,
          memo: input.memo ?? null,
          journalId: posted.journalId,
          createdBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'investors.capital.received',
          entityType: 'Investment',
          entityId: input.investmentId,
          before: null,
          after: {
            investorId: investor.id,
            amountPoisha: amount.toString(),
            walletAccountId: wallet.id,
            businessDate: posted.businessDate,
            lockInUntil: input.lockInUntil ?? null,
            journalId: posted.journalId,
            idempotencyKey: draft.idempotencyKey,
          },
          requestId: context.requestId,
          request,
        });

        // Through `serializeFor` like every read (invariant 5): nothing here is a
        // cost field today, and the strip belongs in place before one is added.
        return serializeFor(context, 'Investor', {
          investmentId: input.investmentId,
          investorId: investor.id,
          amountPoisha: amount.toString(),
          businessDate: posted.businessDate,
          journalId: posted.journalId,
          lockInUntil: input.lockInUntil ?? null,
        });
      }),
    );
  }

  /** The contributions the caller may see, newest first. */
  async list(
    context: ActiveContext,
    request: object,
    query: { readonly investorId?: string | undefined },
  ) {
    const scope = investorScope(request);
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listInvestments(tx, context.orgId, {
          scope,
          investorId: query.investorId,
        });
        return serializeFor(context, 'Investor', {
          items: rows.map((row) => ({
            id: row.id,
            investorId: row.investor_id,
            amountPoisha: row.amount_poisha,
            walletAccountId: row.wallet_account_id,
            businessDate: row.business_date,
            lockInUntil: row.lock_in_until,
            terms: row.terms,
            memo: row.memo,
            journalId: row.journal_id,
          })),
        });
      }),
    );
  }

  private view(row: repo.InvestmentRow): InvestmentResult {
    return {
      investmentId: row.id,
      investorId: row.investor_id,
      amountPoisha: row.amount_poisha,
      businessDate: row.business_date,
      journalId: row.journal_id,
      lockInUntil: row.lock_in_until,
    };
  }
}
