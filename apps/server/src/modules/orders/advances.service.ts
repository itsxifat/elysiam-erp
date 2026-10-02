import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  acceptsAdvanceClaim,
  advanceVerification,
  allocateApplied,
  customerAdvanceDraft,
  DEFAULT_ADVANCE_POLICY,
  normalizeTransactionRef,
  parseAdvanceDisposition,
  poisha,
  remainingOf,
  settlementsFor,
  sub,
  totalOf,
  type AccountSubtype,
  type AdvancePolicy,
  type AdvanceSettlement,
  type HeldAdvance,
  type OrderStatus,
  type PostingAccount,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import * as advances from './advances.repository.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import * as repo from './orders.repository.js';
import type { RecordAdvanceInput, RefundAdvanceInput } from './orders.schemas.js';
import { orderScopeSql } from './orders.scope.js';
import { CourierBookingRegistry } from './ports/courier-booking.port.js';

/**
 * Advances against an order, from claim to ending (M17; D-013, D-230 to D-233).
 *
 * Three people touch an advance, and the split is the control:
 *
 * - **The agent** records the claim from the buyer's SMS: method, reference, amount. It
 *   posts nothing and leaves the COD alone (check 2): a claim is a promise, not money.
 * - **Accounts** checks the wallet and verifies it, naming the wallet the money is in, or
 *   rejects it. Verification is the only thing that posts Dr Wallet / Cr Customer advance,
 *   and the recorder can never be the verifier (the database refuses it too).
 * - **The order's own transitions** end it: a delivery applies it (the delivery journal
 *   already debits Customer advance), a cancel or a return refunds or keeps what is left,
 *   per the brand's policy (check 1). A refund is owed at the ending and posted when
 *   accounts records that the money actually went back, so the books never say a wallet
 *   paid out what it still holds.
 *
 * The transitions call `applyOnDelivery` and `settleOnEnding` inside their own
 * transaction, through `TransitionsService`'s effects, so an advance can never end without
 * the order it belongs to ending in the same commit.
 */
@Injectable()
export class AdvancesService {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly audit: AuditService,
    private readonly courier: CourierBookingRegistry,
  ) {}

  // --- the agent ------------------------------------------------------------------

  /** The order's advances, for its detail page. Same scope as reading the order. */
  async listForOrder(context: ActiveContext, request: object, orderId: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await repo.orderByIdInScope(
          tx,
          context.orgId,
          orderId,
          orderScopeSql(context, request),
        );
        if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        const rows = await advances.advancesOfOrder(tx, context.orgId, order.id);
        return { orderId: order.id, items: rows.map(toAdvanceView) };
      }),
    );
  }

  /** Record a claim (D-230). Nothing posts, and the COD does not move. */
  async record(
    context: ActiveContext,
    request: AuditableRequest,
    orderId: string,
    input: RecordAdvanceInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const order = await repo.lockOrderInScope(
          tx,
          context.orgId,
          orderId,
          orderScopeSql(context, request),
        );
        if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
        if (!acceptsAdvanceClaim(order.status as OrderStatus)) {
          throw new OrdersError(
            'ADVANCE_INVALID',
            `An order that is ${order.status} no longer takes an advance.`,
          );
        }

        const reference = normalizeTransactionRef(input.transactionRef);
        if (reference === null) {
          throw new OrdersError(
            'ADVANCE_INVALID',
            'That does not look like a transaction id: 6 to 30 letters and digits, with at least one digit.',
          );
        }
        const amount = BigInt(input.amountPoisha);
        if (amount > BigInt(order.cod_amount_poisha)) {
          // §9 refuses a negative COD. Caught here, while the agent is still on the phone,
          // rather than at verification, where it would strand money in a wallet.
          throw new OrdersError(
            'ORDER_TOTAL_INVALID',
            'That advance is more than this order will collect.',
          );
        }
        if (
          (await advances.liveClaimFor(tx, context.orgId, input.method, reference)) !== undefined
        ) {
          throw new OrdersError(
            'ADVANCE_DUPLICATE',
            'That transaction id already backs an advance in this brand.',
          );
        }

        const id = await advances.insertClaim(tx, {
          orgId: context.orgId,
          orderId: order.id,
          method: input.method,
          transactionRef: reference,
          amountPoisha: amount,
          note: input.note ?? null,
          recordedBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'order.advance_claimed',
          entityType: 'order',
          entityId: order.id,
          after: { advanceId: id, method: input.method, amountPoisha: amount.toString() },
          request,
        });

        const row = await advances.advanceById(tx, context.orgId, id);
        if (row === undefined) throw new Error('a recorded claim could not be read back');
        return toAdvanceView(row);
      }),
    );
  }

  // --- accounts -------------------------------------------------------------------

  /** The verification and refund queue (D-235). */
  async queue(context: ActiveContext, request: object, statuses: readonly string[]) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await advances.advanceQueue(
          tx,
          context.orgId,
          statuses,
          scopeWhere(request, { branchId: sql`o.branch_id` }),
        );
        return {
          items: rows.map((row) => ({
            ...toAdvanceView(row),
            orderNo: row.order_no,
            orderStatus: row.order_status,
            codAmountPoisha: row.cod_amount_poisha,
            walletName: row.wallet_name,
          })),
        };
      }),
    );
  }

  /**
   * Verify a claim into the wallet the money arrived in (D-230, D-231).
   *
   * Posts Dr Wallet / Cr Customer advance. Before the parcel moves, the order's advance rises
   * and its COD falls in the same transaction. On an order that has ended, the advance is
   * received and ended in one step, so money found in a wallet always reaches the books with
   * somewhere to go. On an order whose parcel is with a courier, it waits: the courier holds
   * the COD it was given at booking.
   */
  async verify(
    context: ActiveContext,
    request: AuditableRequest,
    advanceId: string,
    walletAccountId: string,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const advance = await this.claimInScope(tx, context, request, advanceId);
        if (advance.row.status !== 'pending') {
          throw new OrdersError(
            'ADVANCE_INVALID',
            `This advance is already ${advance.row.status}.`,
          );
        }
        if (advance.row.recorded_by === context.userId) {
          throw new OrdersError(
            'ADVANCE_SELF_VERIFY',
            'You recorded this advance, so somebody else has to verify it.',
          );
        }
        const order = advance.order;
        const wallet = await this.walletAccount(tx, context.orgId, walletAccountId);

        const status = order.status as OrderStatus;
        const parcelLive =
          acceptsAdvanceClaim(status) && (await this.parcelLive(tx, context.orgId, order.id));
        const outcome = advanceVerification({
          status,
          parcelLive,
          policy: await this.policy(tx, context.orgId),
        });
        if (outcome.kind === 'wait') {
          throw new OrdersError(
            'ADVANCE_PARCEL_IN_FLIGHT',
            'This parcel is booked or on the road with the COD the courier was given. Cancel the booking first, or verify once the order is delivered, returned or cancelled.',
          );
        }

        const amount = BigInt(advance.row.amount_poisha);
        if (outcome.kind === 'apply') {
          const applied = await repo.applyAdvance(tx, {
            orgId: context.orgId,
            orderId: order.id,
            amountPoisha: amount,
          });
          if (!applied) {
            throw new OrdersError(
              'ORDER_TOTAL_INVALID',
              'That advance is more than this order will now collect; reject it and record the right amount.',
            );
          }
        }

        const customerAdvance = await this.account(tx, context.orgId, 'customer_advance');
        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          customerAdvanceDraft({
            advanceId: advance.row.id,
            occurredAt: new Date(),
            direction: 'received',
            wallet,
            customerAdvance,
            amountPoisha: poisha(amount),
            branchId: order.branch_id,
            memo: `Order ${order.order_no} advance ${advance.row.transaction_ref}`,
          }),
        );
        if (!posted.created) {
          // The key is the advance's own; a journal already there means this claim was
          // verified by a transaction that the status column does not reflect.
          throw new OrdersError('IDEMPOTENCY_CONFLICT', 'This advance has already been posted.');
        }
        const marked = await advances.markVerified(tx, {
          orgId: context.orgId,
          id: advance.row.id,
          decidedBy: context.userId,
          walletAccountId: wallet.accountId,
          journalId: posted.journalId,
        });
        if (!marked) {
          throw new OrdersError(
            'ADVANCE_INVALID',
            'This advance was decided while you looked at it.',
          );
        }

        if (outcome.kind === 'settle') {
          // The order has already ended: this advance ends with it, by the same rule (D-231).
          const cap = await advances.keepCap(tx, context.orgId, order.id);
          const [settlement] = settlementsFor(
            [{ id: advance.row.id, amountPoisha: poisha(amount), appliedPoisha: poisha(0n) }],
            outcome.disposition,
            poisha(cap),
          );
          if (settlement !== undefined) await this.settle(tx, context, order, settlement);
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'approve',
          action: 'order.advance_verified',
          entityType: 'order',
          entityId: order.id,
          after: {
            advanceId: advance.row.id,
            walletAccountId: wallet.accountId,
            journalId: posted.journalId,
            outcome: outcome.kind === 'settle' ? outcome.disposition : 'applied_to_cod',
          },
          request,
        });

        return this.viewOf(tx, context.orgId, advance.row.id);
      }),
    );
  }

  /** Accounts found no such money. Nothing posts, and the reference is free again. */
  async reject(
    context: ActiveContext,
    request: AuditableRequest,
    advanceId: string,
    reason: string,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const advance = await this.claimInScope(tx, context, request, advanceId);
        if (advance.row.status !== 'pending') {
          throw new OrdersError(
            'ADVANCE_INVALID',
            `This advance is already ${advance.row.status}.`,
          );
        }
        if (advance.row.recorded_by === context.userId) {
          throw new OrdersError(
            'ADVANCE_SELF_VERIFY',
            'You recorded this advance, so somebody else has to decide it.',
          );
        }
        const marked = await advances.markRejected(tx, {
          orgId: context.orgId,
          id: advance.row.id,
          decidedBy: context.userId,
          reason,
        });
        if (!marked) {
          throw new OrdersError(
            'ADVANCE_INVALID',
            'This advance was decided while you looked at it.',
          );
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'reject',
          action: 'order.advance_rejected',
          entityType: 'order',
          entityId: advance.order.id,
          after: { advanceId: advance.row.id, reason },
          request,
        });
        return this.viewOf(tx, context.orgId, advance.row.id);
      }),
    );
  }

  /**
   * The money went back to the buyer (D-232): Dr Customer advance / Cr Wallet.
   *
   * Only for an advance its order's ending marked `refund_due`. Out of the wallet it came
   * into unless accounts names another, because that is usually where the refund is sent
   * from and the cash book should show it there.
   */
  async refund(
    context: ActiveContext,
    request: AuditableRequest,
    advanceId: string,
    input: RefundAdvanceInput,
  ) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const advance = await this.claimInScope(tx, context, request, advanceId);
        if (advance.row.status !== 'refund_due') {
          throw new OrdersError(
            'ADVANCE_INVALID',
            `Only an advance owed back can be refunded; this one is ${advance.row.status}.`,
          );
        }
        const walletId = input.walletAccountId ?? advance.row.wallet_account_id;
        if (walletId === null) throw new Error('a refund-due advance has no wallet');
        const wallet = await this.walletAccount(tx, context.orgId, walletId);
        const refundRef =
          input.refundRef === undefined ? null : normalizeTransactionRef(input.refundRef);
        if (input.refundRef !== undefined && refundRef === null) {
          throw new OrdersError('ADVANCE_INVALID', 'That does not look like a transaction id.');
        }

        const owed = remainingOf(held(advance.row));
        const customerAdvance = await this.account(tx, context.orgId, 'customer_advance');
        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          customerAdvanceDraft({
            advanceId: advance.row.id,
            occurredAt: new Date(),
            direction: 'refunded',
            wallet,
            customerAdvance,
            amountPoisha: owed,
            branchId: advance.order.branch_id,
            memo: `Order ${advance.order.order_no} advance refunded`,
          }),
        );
        const marked = await advances.markRefunded(tx, {
          orgId: context.orgId,
          id: advance.row.id,
          settledBy: context.userId,
          journalId: posted.journalId,
          walletAccountId: wallet.accountId,
          refundRef,
        });
        if (!marked) {
          throw new OrdersError(
            'ADVANCE_INVALID',
            'This advance was refunded while you looked at it.',
          );
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.advance_refunded',
          entityType: 'order',
          entityId: advance.order.id,
          after: {
            advanceId: advance.row.id,
            amountPoisha: owed.toString(),
            walletAccountId: wallet.accountId,
            journalId: posted.journalId,
          },
          request,
        });
        return this.viewOf(tx, context.orgId, advance.row.id);
      }),
    );
  }

  // --- the transitions' effects -----------------------------------------------------

  /**
   * `apply_advances` (D-233): each held advance records its share of what the delivery
   * journal applied, oldest first, after any exchange credit on the order.
   */
  async applyOnDelivery(
    tx: Tx,
    orgId: string,
    order: repo.OrderRow,
    appliedPoisha: bigint,
  ): Promise<void> {
    const rows = await advances.lockHeldAdvances(tx, orgId, order.id);
    if (rows.length === 0) return;
    const holding = rows.map(held);
    /*
     * The order's advance column is the verified advances plus any exchange credit (M10).
     * Nothing has ended yet when an order is delivered, so every held row is one that raised
     * the column, and the difference is the credit.
     */
    const credit = sub(poisha(BigInt(order.advance_paid_poisha)), totalOf(holding));
    if (credit < 0n) {
      throw new OrdersError(
        'ORDER_TOTAL_INVALID',
        'This order’s advances add up to more than its advance column; the order needs a look before it can deliver.',
      );
    }
    const shares = allocateApplied(holding, poisha(appliedPoisha), credit);
    for (const share of shares) {
      const moved = await advances.addApplied(tx, {
        orgId,
        id: share.id,
        appliedPoisha: share.appliedPoisha,
      });
      if (!moved) throw new OrdersError('ADVANCE_INVALID', 'An advance moved during the delivery.');
    }
  }

  /**
   * `settle_advances` (D-232): what is left of each held advance is refunded or kept, per
   * the brand's policy for this ending.
   */
  async settleOnEnding(
    tx: Tx,
    context: ActiveContext,
    order: repo.OrderRow,
    ending: 'cancel' | 'return',
  ): Promise<void> {
    const rows = await advances.lockHeldAdvances(tx, context.orgId, order.id);
    if (rows.length === 0) return;
    const policy = await this.policy(tx, context.orgId);
    const disposition = ending === 'cancel' ? policy.onCancel : policy.onReturn;
    const cap = await advances.keepCap(tx, context.orgId, order.id);
    for (const settlement of settlementsFor(rows.map(held), disposition, poisha(cap))) {
      await this.settle(tx, context, order, settlement);
    }
  }

  // --- the pieces -------------------------------------------------------------------

  /**
   * One advance's ending: post what the brand keeps (Dr Customer advance / Cr Other income),
   * and leave what goes back owed until accounts records the refund (D-232).
   */
  private async settle(
    tx: Tx,
    context: ActiveContext,
    order: Pick<repo.OrderRow, 'branch_id' | 'order_no'>,
    settlement: AdvanceSettlement,
  ): Promise<void> {
    let keptJournalId: string | null = null;
    if (settlement.keptPoisha > 0n) {
      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        customerAdvanceDraft({
          advanceId: settlement.id,
          occurredAt: new Date(),
          direction: 'forfeited',
          otherIncome: await this.account(tx, context.orgId, 'other_income'),
          customerAdvance: await this.account(tx, context.orgId, 'customer_advance'),
          amountPoisha: settlement.keptPoisha,
          branchId: order.branch_id,
          memo: `Order ${order.order_no} advance kept`,
        }),
      );
      keptJournalId = posted.journalId;
    }

    const marked =
      settlement.refundPoisha > 0n
        ? await advances.markRefundDue(tx, {
            orgId: context.orgId,
            id: settlement.id,
            keptPoisha: settlement.keptPoisha,
            keptJournalId,
          })
        : keptJournalId !== null &&
          (await advances.markForfeited(tx, {
            orgId: context.orgId,
            id: settlement.id,
            keptPoisha: settlement.keptPoisha,
            keptJournalId,
            settledBy: context.userId,
          }));
    if (!marked)
      throw new OrdersError('ADVANCE_INVALID', 'An advance moved while its order ended.');
  }

  /** The claim and its order, both locked, or a 404 for a caller who cannot see the order. */
  private async claimInScope(
    tx: Tx,
    context: ActiveContext,
    request: object,
    advanceId: string,
  ): Promise<{ row: advances.AdvanceRow; order: repo.OrderRow }> {
    const peek = await advances.advanceById(tx, context.orgId, advanceId);
    if (peek === undefined) throw new OrdersError('ADVANCE_NOT_FOUND', 'No such advance.');
    // The order first, then the advance: the same lock order as a transition, which locks
    // the order and then its advances, so the two cannot deadlock each other.
    const order = await repo.lockOrderInScope(
      tx,
      context.orgId,
      peek.order_id,
      scopeWhere(request, { branchId: sql`o.branch_id` }),
    );
    if (order === undefined) throw new OrdersError('ADVANCE_NOT_FOUND', 'No such advance.');
    const row = await advances.lockAdvance(tx, context.orgId, advanceId);
    if (row === undefined) throw new OrdersError('ADVANCE_NOT_FOUND', 'No such advance.');
    return { row, order };
  }

  private async walletAccount(tx: Tx, orgId: string, id: string): Promise<PostingAccount> {
    const account = await repo.accountById(tx, orgId, id);
    if (!account?.subtype.startsWith('wallet_')) {
      throw new OrdersError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        'That is not an active wallet of this brand.',
      );
    }
    return {
      accountId: account.id,
      // A `wallet_*` subtype, checked just above and again by the posting rule.
      subtype: account.subtype as AccountSubtype,
      branchId: account.branch_id,
    };
  }

  private async account(tx: Tx, orgId: string, subtype: AccountSubtype): Promise<PostingAccount> {
    const row = await repo.accountBySubtype(tx, orgId, subtype);
    if (row === undefined) {
      throw new OrdersError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        `This organization has no ${subtype} account.`,
      );
    }
    return { accountId: row.id, subtype, branchId: row.branch_id };
  }

  private async policy(tx: Tx, orgId: string): Promise<AdvancePolicy> {
    const stored = await advances.advancePolicySettings(tx, orgId);
    return {
      onCancel: parseAdvanceDisposition(stored.onCancel, DEFAULT_ADVANCE_POLICY.onCancel),
      onReturn: parseAdvanceDisposition(stored.onReturn, DEFAULT_ADVANCE_POLICY.onReturn),
    };
  }

  private async parcelLive(tx: Tx, orgId: string, orderId: string): Promise<boolean> {
    const courier = this.courier.current();
    return courier === undefined ? false : courier.hasLiveParcel(tx, orgId, orderId);
  }

  private async viewOf(tx: Tx, orgId: string, id: string) {
    const row = await advances.advanceById(tx, orgId, id);
    if (row === undefined) throw new OrdersError('ADVANCE_NOT_FOUND', 'No such advance.');
    return toAdvanceView(row);
  }
}

function held(row: advances.AdvanceRow): HeldAdvance {
  return {
    id: row.id,
    amountPoisha: poisha(BigInt(row.amount_poisha)),
    appliedPoisha: poisha(BigInt(row.applied_poisha)),
    keptPoisha: poisha(BigInt(row.kept_poisha)),
  };
}

/** One advance, as every screen sees it. Money as strings of poisha (invariant 1). */
export function toAdvanceView(row: advances.AdvanceRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    method: row.method,
    transactionRef: row.transaction_ref,
    amountPoisha: row.amount_poisha,
    appliedPoisha: row.applied_poisha,
    keptPoisha: row.kept_poisha,
    status: row.status,
    note: row.note,
    recordedBy: row.recorded_by,
    recordedAt: new Date(row.recorded_at).toISOString(),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at === null ? null : new Date(row.decided_at).toISOString(),
    rejectReason: row.reject_reason,
    walletAccountId: row.wallet_account_id,
    settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
    refundRef: row.refund_ref,
  };
}
