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
  voidVerification,
  poisha,
  remainingOf,
  settlementsFor,
  sub,
  totalOf,
  type AccountSubtype,
  type AdvancePolicy,
  type AdvanceStatus,
  type AdvanceSettlement,
  type GatewayAdvanceMethod,
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
import { OwnershipGate } from './ownership.gate.js';
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
    private readonly gate: OwnershipGate,
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
        // M41 (D-710): recording the buyer's advance is the owner's work.
        await this.gate.check(tx, context, request, order, 'advance');
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
        if ((await advances.liveClaimFor(tx, context.orgId, reference)) !== undefined) {
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
          if (settlement !== undefined) {
            await this.settle(tx, context, order, settlement, new Date());
          }
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
        if (!posted.created) {
          // Keyed on the advance: a refund journal already there means this one was paid.
          throw new OrdersError('IDEMPOTENCY_CONFLICT', 'This refund has already been posted.');
        }
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

  /**
   * Undo a mistaken verification (D-236): the reversal of its received journal, and the COD
   * back up, in one transaction.
   *
   * Invariant 2 fixes a posted mistake with a reversal journal, never an edit. Only while the
   * COD is still ours to change (before the parcel moves, no booking holding the old figure)
   * and before anything used the advance, and never by the person who verified it. The
   * claim's reference is free again afterwards, so the agent can record the right one.
   */
  async void(context: ActiveContext, request: AuditableRequest, advanceId: string, reason: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const advance = await this.claimInScope(tx, context, request, advanceId);
        const status = advance.order.status as OrderStatus;
        const outcome = voidVerification({
          advanceStatus: advance.row.status as AdvanceStatus,
          appliedPoisha: poisha(BigInt(advance.row.applied_poisha)),
          orderStatus: status,
          parcelLive:
            acceptsAdvanceClaim(status) &&
            (await this.parcelLive(tx, context.orgId, advance.order.id)),
        });
        if (outcome === 'not_verified') {
          throw new OrdersError(
            'ADVANCE_INVALID',
            `Only a verified advance nothing has used can be undone; this one is ${advance.row.status}.`,
          );
        }
        if (outcome === 'parcel_in_flight') {
          throw new OrdersError(
            'ADVANCE_PARCEL_IN_FLIGHT',
            'This parcel is booked or on the road with the lower COD. Cancel the booking first.',
          );
        }
        if (advance.row.decided_by === context.userId) {
          // Four eyes both ways: a void takes money off a wallet's books and raises the COD
          // again, so the person who verified cannot also undo it (the database agrees).
          throw new OrdersError(
            'ADVANCE_SELF_VERIFY',
            'You verified this advance, so somebody else has to undo it.',
          );
        }
        const receivedJournalId = advance.row.received_journal_id;
        if (receivedJournalId === null) throw new Error('a verified advance has no journal');

        const unapplied = await repo.unapplyAdvance(tx, {
          orgId: context.orgId,
          orderId: advance.order.id,
          amountPoisha: BigInt(advance.row.amount_poisha),
        });
        if (!unapplied) {
          throw new OrdersError(
            'ORDER_TOTAL_INVALID',
            'This order no longer carries that advance.',
          );
        }
        const reversal = await this.ledger.reverse(
          tx,
          { orgId: context.orgId, userId: context.userId },
          receivedJournalId,
          `Advance ${advance.row.transaction_ref} voided: ${reason}`,
        );
        if (!reversal.created) {
          throw new OrdersError('IDEMPOTENCY_CONFLICT', 'This verification was already reversed.');
        }
        const marked = await advances.markVoided(tx, {
          orgId: context.orgId,
          id: advance.row.id,
          voidedBy: context.userId,
          reason,
          journalId: reversal.journalId,
        });
        if (!marked) {
          throw new OrdersError('ADVANCE_INVALID', 'This advance moved while you looked at it.');
        }
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'order.advance_voided',
          entityType: 'order',
          entityId: advance.order.id,
          after: { advanceId: advance.row.id, reason, journalId: reversal.journalId },
          request,
        });
        return this.viewOf(tx, context.orgId, advance.row.id);
      }),
    );
  }

  // --- a payment gateway ----------------------------------------------------------

  /**
   * A website payment the gateway validated, booked as a verified advance at once (M34,
   * D-526): Dr the gateway's clearing wallet / Cr Customer advance, through the same rule an
   * accounts verification posts (`customerAdvanceDraft`), and, before the parcel moves, the
   * COD down by the amount in the same transaction.
   *
   * The four eyes are two system actors and the gateway: the website's checkout records the
   * claim (`recordedBy`) and SSLCommerz's own validation decides it (`decidedBy`). The caller
   * has already compared the validated amount with what the order still collects; nothing
   * here takes a figure on trust from a request.
   *
   * - Before shipping, no parcel booked: applied to the order (the COD falls).
   * - The order already ended (an unpaid order cancelled at sixty minutes, then paid): the
   *   money is received and ended in one step by the brand's cancel policy, so it is owed
   *   back and accounts refunds it (D-527).
   * - A parcel booked or on the road: left as a **pending claim** for accounts to verify into
   *   the same wallet once the order ends; nothing posts and the COD stays (D-231).
   *
   * Idempotent per transaction reference: the live-reference index refuses a second claim for
   * the same gateway transaction, and the journal key is the advance's own.
   */
  async recordGatewayAdvance(
    tx: Tx,
    actor: { readonly orgId: string; readonly recordedBy: string; readonly decidedBy: string },
    input: {
      readonly orderId: string;
      readonly method: GatewayAdvanceMethod;
      readonly transactionRef: string;
      readonly amountPoisha: bigint;
      readonly wallet: PostingAccount;
      readonly note: string | null;
      readonly owedBack?: boolean;
    },
  ): Promise<{ readonly advanceId: string; readonly outcome: 'applied' | 'settled' | 'held' }> {
    const order = await repo.orderForUpdate(tx, actor.orgId, input.orderId);
    if (order === undefined) throw new OrdersError('ORDER_NOT_FOUND', 'No such order.');
    const reference = normalizeTransactionRef(input.transactionRef);
    if (reference === null) {
      throw new OrdersError('ADVANCE_INVALID', 'A gateway transaction reference is malformed.');
    }
    if (input.amountPoisha <= 0n) {
      throw new OrdersError('ADVANCE_INVALID', 'A gateway payment must be a positive amount.');
    }
    if (!input.wallet.subtype.startsWith('wallet_')) {
      throw new OrdersError('LEDGER_ACCOUNT_NOT_FOUND', 'A gateway payment lands in a wallet.');
    }
    const existing = await advances.liveClaimFor(tx, actor.orgId, reference);
    if (existing !== undefined) {
      throw new OrdersError(
        'ADVANCE_DUPLICATE',
        'That gateway transaction already backs an advance in this brand.',
      );
    }

    const id = await advances.insertClaim(tx, {
      orgId: actor.orgId,
      orderId: order.id,
      method: input.method,
      transactionRef: reference,
      amountPoisha: input.amountPoisha,
      note: input.note,
      recordedBy: actor.recordedBy,
    });
    const context = gatewayContext(actor.orgId, actor.decidedBy);

    const status = order.status as OrderStatus;
    const parcelLive =
      acceptsAdvanceClaim(status) && (await this.parcelLive(tx, actor.orgId, order.id));
    const verified = advanceVerification({
      status,
      parcelLive,
      policy: await this.policy(tx, actor.orgId),
    });
    // A gateway payment the order does not accept, or one that lands on an order already
    // ended, is owed back in full: the cancel policy's "keep up to the delivery charge" is for
    // an advance the shopper paid before the order ended, never for money that arrived after
    // the system itself cancelled it (M34 ledger audit W2, W3; D-526, D-527).
    const outcome: typeof verified =
      input.owedBack === true || verified.kind === 'settle'
        ? { kind: 'settle', disposition: 'refund' }
        : verified;
    if (outcome.kind === 'wait') {
      // The courier holds the COD it was given; accounts verifies this claim once the order
      // ends, into the wallet the gateway paid (D-231).
      await this.audit.record(tx, {
        orgId: actor.orgId,
        actorUserId: actor.recordedBy,
        operation: 'create',
        action: 'order.advance_claimed',
        entityType: 'order',
        entityId: order.id,
        after: { advanceId: id, method: input.method, amountPoisha: input.amountPoisha.toString() },
        request: {},
      });
      return { advanceId: id, outcome: 'held' };
    }

    if (outcome.kind === 'apply') {
      const applied = await repo.applyAdvance(tx, {
        orgId: actor.orgId,
        orderId: order.id,
        amountPoisha: input.amountPoisha,
      });
      if (!applied) {
        throw new OrdersError(
          'ORDER_TOTAL_INVALID',
          'That payment is more than this order still collects.',
        );
      }
    }

    const customerAdvance = await this.account(tx, actor.orgId, 'customer_advance');
    const posted = await this.ledger.post(
      tx,
      { orgId: actor.orgId, userId: actor.decidedBy },
      customerAdvanceDraft({
        advanceId: id,
        occurredAt: new Date(),
        direction: 'received',
        wallet: input.wallet,
        customerAdvance,
        amountPoisha: poisha(input.amountPoisha),
        branchId: order.branch_id,
        memo: `Order ${order.order_no} paid online ${reference}`,
      }),
    );
    const marked = await advances.markVerified(tx, {
      orgId: actor.orgId,
      id,
      decidedBy: actor.decidedBy,
      walletAccountId: input.wallet.accountId,
      journalId: posted.journalId,
    });
    if (!marked)
      throw new OrdersError('ADVANCE_INVALID', 'A gateway advance moved as it was booked.');

    if (outcome.kind === 'settle') {
      const cap = await advances.keepCap(tx, actor.orgId, order.id);
      const [settlement] = settlementsFor(
        [{ id, amountPoisha: poisha(input.amountPoisha), appliedPoisha: poisha(0n) }],
        outcome.disposition,
        poisha(cap),
      );
      if (settlement !== undefined) await this.settle(tx, context, order, settlement, new Date());
    }

    await this.audit.record(tx, {
      orgId: actor.orgId,
      actorUserId: actor.decidedBy,
      operation: 'approve',
      action: 'order.advance_verified',
      entityType: 'order',
      entityId: order.id,
      after: {
        advanceId: id,
        method: input.method,
        walletAccountId: input.wallet.accountId,
        journalId: posted.journalId,
        outcome: outcome.kind === 'settle' ? outcome.disposition : 'applied_to_cod',
      },
      request: {},
    });
    return { advanceId: id, outcome: outcome.kind === 'settle' ? 'settled' : 'applied' };
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
    occurredAt: Date,
  ): Promise<void> {
    const rows = await advances.lockHeldAdvances(tx, context.orgId, order.id);
    if (rows.length === 0) return;
    const policy = await this.policy(tx, context.orgId);
    const disposition = ending === 'cancel' ? policy.onCancel : policy.onReturn;
    const cap = await advances.keepCap(tx, context.orgId, order.id);
    for (const settlement of settlementsFor(rows.map(held), disposition, poisha(cap))) {
      // Dated with the ending itself, so a kept advance lands on the same business date as
      // the return or the cancel that kept it.
      await this.settle(tx, context, order, settlement, occurredAt);
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
    occurredAt: Date,
  ): Promise<void> {
    let keptJournalId: string | null = null;
    if (settlement.keptPoisha > 0n) {
      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        customerAdvanceDraft({
          advanceId: settlement.id,
          occurredAt,
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
    // Still a liability: held, or owed back. The domain's arithmetic, not the screen's.
    owedPoisha:
      row.status === 'verified' || row.status === 'refund_due'
        ? remainingOf(held(row)).toString()
        : '0',
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
    voidReason: row.void_reason,
    voidedAt: row.voided_at === null ? null : new Date(row.voided_at).toISOString(),
  };
}

/** The gateway acting as the decider, for the ending a late payment is settled by (D-527). */
function gatewayContext(orgId: string, userId: string): ActiveContext {
  return {
    orgId,
    userId,
    isSuperAdmin: false,
    roles: [],
    branchIds: [],
    branchIdsByRole: {},
    requestId: '',
  };
}
