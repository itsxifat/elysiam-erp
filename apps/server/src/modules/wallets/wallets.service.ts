import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import {
  aggregateBalanceOf,
  businessDate,
  isAccountSubtype,
  subtypeInfo,
  type AccountSubtype,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './wallets.repository.js';
import { walletsHttpError } from './wallets.errors.js';
import type { CreateWalletInput, UpdateWalletInput } from './wallets.schemas.js';

/**
 * Wallet setup and the wallet list (architecture §6 "Wallets, cash entries,
 * petty cash", §7).
 *
 * A wallet is a `wallet_*` ledger account plus the operational facts a chart of
 * accounts has no column for, and its **balance is derived on every read** from
 * `ledger.journal_lines`. There is no balance column to keep in step, which is
 * the whole of M08 check 1: a maintained balance drifts the first time a journal
 * is posted by a path that forgets to update it, and nobody finds out until they
 * count the till.
 *
 * Branch scope is applied to the wallet's own branch (§6 gives branch_manager
 * `Wallet` at `branch` scope), so a showroom manager sees their branch's till and
 * not the brand's bank account — and a wallet outside their scope answers exactly
 * as one that does not exist.
 */

export interface WalletView {
  readonly id: string;
  readonly ledgerAccountId: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly branchId: string | null;
  readonly provider: string | null;
  readonly accountRefMasked: string | null;
  readonly requiresDailyClosing: boolean;
  readonly isActive: boolean;
  /** Integer poisha as a decimal string, derived from journal lines (§23). */
  readonly balancePoisha: string;
}

@Injectable()
export class WalletsService {
  constructor(private readonly audit: AuditService) {}

  /** Every wallet the caller may see, with its derived balance as of a date. */
  async list(
    context: ActiveContext,
    request: object,
    options: { readonly asOf?: string; readonly includeInactive?: boolean } = {},
  ): Promise<{ asOf: string; items: WalletView[]; totalPoisha: string }> {
    const asOf = options.asOf ?? businessDate(new Date());
    const scope = scopeWhere(request, { branchId: sql`w.branch_id` });

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listWallets(tx, context.orgId, {
        scope,
        includeInactive: options.includeInactive ?? false,
      });
      const balances = await this.balancesFor(tx, context.orgId, asOf, rows);

      const items = rows.map((row) => ({
        id: row.id,
        ledgerAccountId: row.ledger_account_id,
        code: row.code,
        name: row.name,
        subtype: row.subtype,
        branchId: row.branch_id,
        provider: row.provider,
        accountRefMasked: row.account_ref_masked,
        requiresDailyClosing: row.requires_daily_closing,
        isActive: row.is_active,
        balancePoisha: (balances.get(row.ledger_account_id) ?? 0n).toString(),
      }));

      return {
        asOf,
        items,
        // The total of what the caller can see, not of what the org holds. A
        // branch manager's "total cash" is their branch's tills, and labelling a
        // partial sum as the org's would be a wrong number rather than a
        // withheld one.
        totalPoisha: items
          .reduce((total, item) => total + BigInt(item.balancePoisha), 0n)
          .toString(),
      };
    });
  }

  /**
   * Register a wallet, creating its ledger account when it does not exist yet.
   *
   * `wallet_cash` must name a branch: §7 keeps hand cash per branch, and the
   * `accounts_wallet_cash_has_branch` CHECK refuses otherwise. The other three
   * subtypes are org-level, and passing a branch for them is refused rather than
   * ignored — a bank account silently attached to one showroom would quietly
   * disappear from every other branch manager's screen.
   */
  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateWalletInput,
  ): Promise<WalletView> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const subtype =
        'existingAccountId' in input.account
          ? await this.subtypeOfExisting(tx, context.orgId, input.account.existingAccountId)
          : input.account.subtype;

      const branchId = input.branchId ?? null;
      if (subtype === 'wallet_cash' && branchId === null) {
        throw walletsHttpError(
          'LEDGER_ACCOUNT_INVALID',
          'Hand cash is kept per branch (§7); name the branch.',
        );
      }
      if (subtype !== 'wallet_cash' && branchId !== null) {
        throw walletsHttpError(
          'LEDGER_ACCOUNT_INVALID',
          'Only hand cash belongs to a branch; a bank or MFS wallet is org-level.',
        );
      }
      // A branch manager may only set up their own branch's till. Asserted on the
      // row about to be inserted, which is what `ScopeInterceptor` requires of a
      // create (D-061).
      assertInScope(request, { branchId });

      const accountId = await this.resolveAccount(tx, context.orgId, input, subtype, branchId);

      const id = await repo.insertWallet(tx, {
        orgId: context.orgId,
        ledgerAccountId: accountId,
        branchId,
        provider: input.provider ?? null,
        // Already only the last digits, by the schema's regex. Storing a full
        // account number here would put it in every backup and every export
        // (invariant 10).
        accountRefMasked:
          input.accountRefLast4 === undefined ? null : `••••${input.accountRefLast4}`,
        requiresDailyClosing: input.requiresDailyClosing,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'wallets.wallet.created',
        entityType: 'Wallet',
        entityId: id,
        before: null,
        after: { ledgerAccountId: accountId, subtype, branchId },
        requestId: context.requestId,
        request,
      });

      const row = await repo.walletById(tx, context.orgId, id);
      if (row === undefined) throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
      return {
        id: row.id,
        ledgerAccountId: row.ledger_account_id,
        code: row.code,
        name: row.name,
        subtype: row.subtype,
        branchId: row.branch_id,
        provider: row.provider,
        accountRefMasked: row.account_ref_masked,
        requiresDailyClosing: row.requires_daily_closing,
        isActive: row.is_active,
        // A wallet just created has no journals against it. Stated rather than
        // queried, because querying for a guaranteed zero is a round trip.
        balancePoisha: '0',
      };
    });
  }

  /** Rename the provider, change the closing requirement, or deactivate. */
  async update(
    context: ActiveContext,
    request: AuditableRequest,
    walletId: string,
    patch: UpdateWalletInput,
  ): Promise<{ id: string }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.walletById(tx, context.orgId, walletId);
      if (before === undefined) {
        throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such wallet.');
      }
      assertInScope(request, { branchId: before.branch_id });

      // Closing takes a wallet off the cash screens and blocks every movement out
      // of it, so one still holding money would strand that money where nobody
      // counts it while the balance sheet still shows it (ledger audit W3). Every
      // posted journal counts, whatever its date.
      if (patch.isActive === false && before.is_active) {
        const [row] = await repo.balancesAsOf(tx, context.orgId, '9999-12-31', [
          before.ledger_account_id,
        ]);
        const balance =
          row === undefined
            ? 0n
            : aggregateBalanceOf('debit', BigInt(row.debit_poisha), BigInt(row.credit_poisha));
        if (balance !== 0n) {
          throw walletsHttpError(
            'WALLET_NOT_EMPTY',
            'That wallet still holds money. Move it out with a transfer, then close the wallet.',
          );
        }
      }

      await repo.updateWallet(tx, context.orgId, walletId, patch);

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'wallets.wallet.updated',
        entityType: 'Wallet',
        entityId: walletId,
        before: {
          provider: before.provider,
          requiresDailyClosing: before.requires_daily_closing,
          isActive: before.is_active,
        },
        after: patch,
        requestId: context.requestId,
        request,
      });

      return { id: walletId };
    });
  }

  /**
   * The categories a cash entry may name: other income, operating expense, ad spend.
   *
   * A branch-scoped caller sees their branch's categories plus the org-level ones,
   * because an operating-expense account is normally org-level and a showroom
   * legitimately books rent against it. Category *names* are not scoped data; what
   * is scoped is the wallet the money moves through, and that is checked when the
   * entry is recorded. `scopeWhere` is still called so `ScopeInterceptor` can see
   * that this handler considered the caller's scope rather than forgetting it.
   */
  async categories(context: ActiveContext, request: object) {
    const scope = sql`(${scopeWhere(request, { branchId: sql`branch_id` })} or branch_id is null)`;
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listCategories(tx, context.orgId, scope)).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        class: row.class,
        subtype: row.subtype,
        branchId: row.branch_id,
      })),
    }));
  }

  /** Σ debit − Σ credit on each wallet's account, on its normal (debit) side. */
  private async balancesFor(
    tx: Parameters<typeof repo.balancesAsOf>[0],
    orgId: string,
    asOf: string,
    rows: readonly repo.WalletRow[],
  ): Promise<Map<string, bigint>> {
    const totals = await repo.balancesAsOf(
      tx,
      orgId,
      asOf,
      rows.map((row) => row.ledger_account_id),
    );
    return new Map(
      totals.map((row) => [
        row.account_id,
        // Plain bigint, not Poisha: a sum of stored journals is not an amount
        // anyone typed, and a report that throws past ±9e15 is a report nobody
        // can open again (D-079).
        aggregateBalanceOf('debit', BigInt(row.debit_poisha), BigInt(row.credit_poisha)),
      ]),
    );
  }

  private async subtypeOfExisting(
    tx: Parameters<typeof repo.accountById>[0],
    orgId: string,
    accountId: string,
  ): Promise<AccountSubtype> {
    const account = await repo.accountById(tx, orgId, accountId);
    // The same answer for another org's account as for one that does not exist:
    // RLS has already made them the same thing.
    if (account === undefined || !isAccountSubtype(account.subtype)) {
      throw walletsHttpError('LEDGER_ACCOUNT_NOT_FOUND', 'No such ledger account.');
    }
    if (!subtypeInfo(account.subtype).wallet) {
      throw walletsHttpError(
        'LEDGER_ACCOUNT_INVALID',
        `Account ${account.code} is a ${account.subtype} account, not a wallet.`,
      );
    }
    if (!account.is_active) {
      throw walletsHttpError('WALLET_INACTIVE', `Account ${account.code} is inactive.`);
    }
    return account.subtype;
  }

  private async resolveAccount(
    tx: Parameters<typeof repo.accountById>[0],
    orgId: string,
    input: CreateWalletInput,
    subtype: AccountSubtype,
    branchId: string | null,
  ): Promise<string> {
    if ('existingAccountId' in input.account) return input.account.existingAccountId.toLowerCase();

    const info = subtypeInfo(subtype);
    const inserted = await repo.insertLedgerAccount(tx, {
      orgId,
      code: input.account.code,
      name: input.account.name,
      subtype,
      // Never from the client: an account's class and normal balance follow from
      // its subtype, and a wallet booked as a liability would make every report
      // that touches it wrong in a way nothing would flag.
      class: info.class,
      normalBalance: info.normalBalance,
      branchId,
    });
    if (inserted !== undefined) return inserted.id;

    // The code is taken. Reuse the account if it is the same kind of wallet —
    // re-running setup is a normal thing to do — and refuse otherwise rather
    // than quietly attaching a wallet to the org's rent account.
    const existing = await repo.accountByCode(tx, orgId, input.account.code);
    if (existing?.subtype !== subtype) {
      throw walletsHttpError(
        'LEDGER_ACCOUNT_INVALID',
        `Account code ${input.account.code} already belongs to a different account.`,
      );
    }
    return existing.id;
  }
}
