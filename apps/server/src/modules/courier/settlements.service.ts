import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { poisha, toIsoDate, type IsoDate } from '@elysium/domain';
import {
  codSettlementDraft,
  courierChargesDraft,
  matchSettlement,
  resolveSettlementPostingDate,
  settlementOwesCourier,
  settlementPostsAnything,
  settlementRelievesPoisha,
  type SettlementCandidate,
} from '@elysium/domain/courier';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { COURIER_ADAPTERS, type CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { courierEnv } from './courier.config.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { openCredentials } from './credentials.js';
import { LEDGER_READ_PORT, type LedgerReadPort } from './ports/ledger-read.port.js';
import { WALLETS_PORT, type WalletsPort } from './ports/wallets.port.js';
import type { ImportSettlementInput } from './courier.schemas.js';

/**
 * Settlement import, approval and posting (architecture §7, §9; D-037, D-072; M12 check 4).
 *
 * §9's sentence is "parse the file or API data → match consignments → produce an exceptions
 * report (unmatched, amount mismatch) → approval → posting", and the four arrows are four
 * separate transactions on purpose:
 *
 *  1. **Import** parses, matches and writes the batch and its lines with status `imported`.
 *     Nothing is posted. The operator gets the totals and every exception on the next screen.
 *  2. **Request approval** raises a `settlement_posting` request with the amount *the server
 *     derived* (D-072) and moves the batch to `pending_approval`. From that moment migration
 *     0051 freezes its terms, so the figure a checker approves cannot be edited underneath
 *     them.
 *  3. **Approval** runs this module's executor inside the approving transaction, which is
 *     where the journals post. There is no other path to a posted settlement — no route
 *     posts one directly (D-088), and migration 0051 refuses a `posted` row that does not
 *     name an approved request for this exact amount.
 *  4. **Rejection** closes the batch with a reason and posts nothing.
 *
 * ## D-037, concretely
 *
 * The statement's own date is stored on the row as `settlement_date` and is never rewritten.
 * At posting time `resolveSettlementPostingDate` compares it against the closed months: if
 * its month is closed the journals carry the **day after the latest closed month ends**, the
 * row records `posting_business_date` and `deferred_from_closed_period`, and the journals'
 * memo says which statement date they settled. Migration 0051's
 * `settlements_no_backdating` check refuses the other direction, because the decision's own
 * last sentence is "never silently back-dated".
 */
@Injectable()
export class SettlementsService implements OnModuleInit {
  constructor(
    @Inject(COURIER_ADAPTERS) private readonly adapters: CourierAdapterRegistry,
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    @Inject(LEDGER_READ_PORT) private readonly accounts: LedgerReadPort,
    @Inject(WALLETS_PORT) private readonly wallets: WalletsPort,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Register what approving a `settlement_posting` does.
   *
   * On module init, like the ledger registers `period_reopen`. The executor is the *only*
   * thing that posts a settlement, so a type with no executor registered would be an
   * approval that says "approved" while the books have not moved — which is why the
   * approvals module refuses to record a decision for a type in its
   * `EXECUTOR_REQUIRED_TYPES`. The INTEGRATION notes ask for `settlement_posting` to be
   * added to that list and to `MODULE_RAISED_TYPES`.
   */
  onModuleInit(): void {
    this.approvals.registerExecutor('settlement_posting', this.executePosting);
  }

  // --- 1. import ----------------------------------------------------------------

  /**
   * Parse a statement, match it, and write the batch.
   *
   * Synchronous, and not a job. §20 lists `delivery.import_settlement` for "on upload or API
   * fetch"; the upload half makes no outbound call, so invariant 6 does not apply — and a job
   * would move a parse that routinely fails (a renamed column, a stray row) into a place
   * where its failure is a dead-letter row instead of a message on the screen of the person
   * who just chose the file.
   */
  async import(context: ActiveContext, request: AuditableRequest, input: ImportSettlementInput) {
    const file = Buffer.from(input.fileBase64, 'base64');
    if (file.length === 0) {
      throw new CourierError('SETTLEMENT_FILE_INVALID', 'That file is empty.');
    }

    /*
     * The parse happens **before** the transaction opens (invariant 6).
     *
     * Both adapters parse a local Buffer today, so no outbound call is involved — but
     * `parseSettlementFile` is handed decrypted credentials, a base URL and a timeout, and §20
     * anticipates the "API fetch" variant of this same method arriving in M15. The first
     * implementation that fetches would then hold a database connection open across a courier
     * round trip. Keeping the parse outside costs nothing and makes that impossible rather than
     * merely unlikely.
     */
    const account = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      repo.accountByCourier(tx, context.orgId, input.courierId),
    );
    if (account === undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_NOT_FOUND',
        'That courier has no account in this organization.',
      );
    }
    const adapter = this.adapters.get(account.provider_code);
    if (adapter?.parseSettlementFile === undefined) {
      throw new CourierError(
        'SETTLEMENT_FILE_INVALID',
        `The ${account.provider_code} adapter cannot read a settlement file.`,
      );
    }
    const parsed = await adapter.parseSettlementFile(
      this.adapterContext(context.orgId, account),
      file,
      input.fileName,
    );

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const walletId = input.walletId ?? account.settlement_wallet_id;
      if (walletId === null || walletId === undefined) {
        throw new CourierError(
          'SETTLEMENT_FILE_INVALID',
          'Name the wallet this settlement is paid into, or set one on the courier account.',
        );
      }
      // Resolved now rather than at posting time, so a settlement whose wallet is wrong is
      // refused by the person importing it instead of by the checker approving it.
      const wallet = await this.wallets.walletAccount(tx, context.orgId, walletId);
      if (wallet === null) {
        throw new CourierError('SETTLEMENT_FILE_INVALID', 'No such active wallet.');
      }

      const settlementDate = toIsoDate(input.settlementDate ?? parsed.settlementDate);

      const candidates: SettlementCandidate[] = (
        await repo.settlementCandidates(tx, context.orgId, input.courierId)
      ).map((row) => ({
        consignmentId: row.consignment_id,
        orderId: row.order_id,
        orderNo: row.order_no,
        consignmentNo: row.consignment_no,
        receivablePoisha: poisha(BigInt(row.receivable_poisha)),
        settled: row.settled,
      }));

      const matched = matchSettlement(parsed.rows, candidates);
      const { totals } = matched;

      if (!settlementPostsAnything(totals)) {
        throw new CourierError(
          'SETTLEMENT_FILE_INVALID',
          'Nothing in that statement matched a consignment of ours, so there is nothing to post.',
        );
      }
      if (settlementOwesCourier(totals)) {
        /*
         * Charges above collections across the whole statement.
         *
         * §7 has no journal for it — "Dr W" with a negative amount is not a journal — and a
         * courier's own practice is to carry the balance into the next statement. Refused with
         * the figure, so the accountant has something to take to the courier.
         */
        throw new CourierError(
          'SETTLEMENT_OWES_COURIER',
          `That statement's charges exceed its collections by ${(-(totals.matchedNetPoisha as bigint)).toString()} poisha, so no wallet can be debited. Settle it with the courier's next statement.`,
        );
      }

      const settlementId = await repo.insertSettlement(tx, {
        orgId: context.orgId,
        courierAccountId: account.id,
        courierId: input.courierId,
        // Org-level. A courier statement covers parcels from every branch, so attaching it to
        // one would make a branch manager's aging report wrong in both directions.
        branchId: null,
        reference: parsed.reference,
        settlementDate,
        fileObjectId: input.fileObjectId ?? null,
        walletId,
        fileGrossPoisha: totals.fileGrossPoisha,
        fileChargesPoisha: totals.fileChargesPoisha,
        fileNetPoisha: totals.fileNetPoisha,
        fileRowCount: totals.fileRowCount,
        matchedGrossPoisha: totals.matchedGrossPoisha,
        matchedChargesPoisha: totals.matchedChargesPoisha,
        matchedDeliveryChargesPoisha: totals.matchedDeliveryChargesPoisha,
        matchedReturnChargesPoisha: totals.matchedReturnChargesPoisha,
        matchedOtherChargesPoisha: totals.matchedOtherChargesPoisha,
        matchedNetPoisha: totals.matchedNetPoisha,
        matchedRowCount: totals.matchedRowCount,
        exceptionCount: totals.exceptionCount,
        importedBy: context.userId,
      });

      await repo.insertSettlementLines(
        tx,
        context.orgId,
        settlementId,
        matched.lines.map((line) => ({
          rowNo: line.rowNo,
          consignmentNo: line.consignmentNo,
          reference: line.reference,
          match: line.match,
          consignmentId: line.consignmentId,
          orderId: line.orderId,
          codCollectedPoisha: line.codCollectedPoisha,
          deliveryChargePoisha: line.deliveryChargePoisha,
          returnChargePoisha: line.returnChargePoisha,
          otherChargePoisha: line.otherChargePoisha,
          netPoisha: line.netPoisha,
          expectedPoisha: line.expectedPoisha,
          note: line.note,
        })),
      );

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'courier.settlement.imported',
        entityType: 'CourierSettlement',
        entityId: settlementId,
        before: null,
        after: {
          courierId: input.courierId,
          reference: parsed.reference,
          settlementDate,
          walletId,
          fileRowCount: totals.fileRowCount,
          matchedRowCount: totals.matchedRowCount,
          exceptionCount: totals.exceptionCount,
          fileGrossPoisha: totals.fileGrossPoisha.toString(),
          matchedGrossPoisha: totals.matchedGrossPoisha.toString(),
          matchedNetPoisha: totals.matchedNetPoisha.toString(),
        },
        requestId: context.requestId,
        request,
      });

      const saved = await repo.settlementById(tx, context.orgId, settlementId);
      if (saved === undefined) throw new CourierError('SETTLEMENT_NOT_FOUND', 'Vanished.');
      return {
        ...view(saved),
        exceptions: matched.exceptions.map((line) => ({
          rowNo: line.rowNo,
          consignmentNo: line.consignmentNo,
          reference: line.reference,
          match: line.match,
          codCollectedPoisha: line.codCollectedPoisha.toString(),
          expectedPoisha: line.expectedPoisha?.toString() ?? null,
          note: line.note,
        })),
      };
    });
  }

  // --- 2. approval --------------------------------------------------------------

  /**
   * Raise the `settlement_posting` request, with the amount the server derived.
   *
   * `amountDerivedByServer: true` is load-bearing (D-072): without it the approvals module
   * treats `settlement_posting` as always requiring a checker, because the generic route
   * lets a requester type their own number. With it, the org's threshold applies — and with
   * no threshold configured a checker is still required, which is the safe default
   * `requiresApproval` gives.
   *
   * The amount is the matched **gross**, not the net: it is what the two journals together
   * take off the courier's balance, so it is the size of the whole transaction. Approving
   * the net would understate a statement that was mostly charges. Migration 0051 checks the
   * same figure, so the two cannot drift.
   *
   * The payload carries ids and counts and **no amount at all** (D-078): `amount_poisha` on
   * the request is the number a checker saw, and a second copy in the payload is a second
   * number that can differ from it — `assertNoMoneyInPayload` in the contracts refuses any
   * key matching /poisha|amount/, at any depth.
   */
  async requestApproval(
    context: ActiveContext,
    request: AuditableRequest,
    settlementId: string,
    input: { reason?: string | undefined },
  ) {
    const batch = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const row = await repo.settlementById(tx, context.orgId, settlementId);
      if (row === undefined) throw new CourierError('SETTLEMENT_NOT_FOUND', 'No such settlement.');
      if (row.status === 'posted') {
        throw new CourierError('SETTLEMENT_ALREADY_POSTED', 'That settlement has already posted.');
      }
      if (row.status !== 'imported') {
        throw new CourierError(
          'SETTLEMENT_TRANSITION_INVALID',
          `That settlement is ${row.status}.`,
        );
      }
      return row;
    });

    /*
     * `approvals.request` opens its own `withOrg`, so this is a second transaction — and it may
     * decide the request *inline*.
     *
     * That second point is the one that bites. D-068 auto-approves below the org's threshold,
     * and `settlement_posting` is not in `NEVER_AUTO_APPROVE_TYPES`, so a batch under the
     * configured threshold is `auto_approved` the moment it is raised and `ApprovalsService`
     * runs `executePosting` right there, inside its own transaction — while this batch is still
     * `imported` and names no approval. The executor therefore has to be able to take a batch
     * from `imported`, which is what `advanceToPendingApproval` below is for; the first version
     * of this refused it and the throw unwound `approvals.request`'s transaction with the
     * request, its audit row and its events, leaving the batch permanently stuck in `imported`
     * with no exit but rejection — for exactly the small statements the threshold was meant to
     * wave through.
     *
     * So after `request` returns, the batch may already be `posted`. The attach below is
     * conditional on `imported`, and its `false` is read against the batch's *current* status
     * rather than treated as a failure.
     */
    const raised = await this.approvals.request(context, {
      type: 'settlement_posting',
      amountPoisha: BigInt(batch.matched_gross_poisha),
      amountDerivedByServer: true,
      /*
       * Declared now, enforced when `settlement_posting` joins `MODULE_RAISED_TYPES`.
       *
       * The flag is only consulted for a type on that list, so today it changes nothing — and
       * it is here because it states the fact that matters: the executor reads `settlementId`
       * out of this payload and posts whatever it names, so this route is the only one that may
       * write it. See the note on `MODULE_RAISED_TYPES` for why the list entry is pending.
       */
      raisedByModule: true,
      payload: {
        settlementId,
        courierId: batch.courier_id,
        walletId: batch.wallet_id,
        settlementDate: batch.settlement_date,
        matchedRowCount: batch.matched_row_count,
        exceptionCount: batch.exception_count,
      },
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      request,
    });

    const attached = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const ok = await repo.attachSettlementApproval(tx, {
        orgId: context.orgId,
        settlementId,
        approvalRequestId: raised.id,
      });
      if (ok) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'courier.settlement.approval_requested',
          entityType: 'CourierSettlement',
          entityId: settlementId,
          before: { status: 'imported' },
          after: { status: 'pending_approval', approvalRequestId: raised.id },
          requestId: context.requestId,
          request,
        });
      }
      return ok;
    });

    if (!attached) {
      /*
       * The attach found the batch somewhere other than `imported`. Either the executor already
       * took it all the way to `posted` (the auto-approved path above), or somebody else moved
       * it. The first is success; the second is not, so the row decides rather than a guess.
       */
      const now = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        repo.settlementById(tx, context.orgId, settlementId),
      );
      if (now?.status !== 'posted') {
        throw new CourierError(
          'SETTLEMENT_TRANSITION_INVALID',
          'That settlement changed while the approval was being raised.',
        );
      }
      return { settlementId, approvalRequestId: raised.id, status: raised.status };
    }

    return { settlementId, approvalRequestId: raised.id, status: raised.status };
  }

  /**
   * Post a settlement, inside the transaction that approved it.
   *
   * This is the only path to a posted settlement. Both journals post here, together, and
   * both are idempotent on their keys, so an executor that somehow ran twice writes one of
   * each.
   *
   * The order is: resolve D-037's date → post charges → post cash → link the consignments →
   * mark the batch posted. The link comes before the mark because migration 0051's
   * constraint trigger on `consignments.settlement_id` requires the settlement to be
   * `posted` — and it is a *deferred* constraint trigger precisely so that this order works:
   * both facts are true at commit.
   */
  private readonly executePosting: ApprovalExecutor = async (tx, { context, approval }) => {
    const settlementId = approval.payload.settlementId;
    if (typeof settlementId !== 'string') {
      throw new CourierError(
        'SETTLEMENT_NOT_FOUND',
        'That approval does not name a settlement to post.',
      );
    }

    const initial = await repo.settlementForUpdate(tx, context.orgId, settlementId);
    if (initial === undefined) {
      throw new CourierError('SETTLEMENT_NOT_FOUND', 'No such settlement.');
    }
    if (initial.status === 'posted') return;

    /*
     * `imported` is legitimate here, and only here.
     *
     * Below the org's threshold a `settlement_posting` is decided the moment it is raised
     * (D-068) and this executor runs inside `approvals.request`'s own transaction — before
     * `requestApproval` has had a chance to attach the approval and move the batch on. So the
     * executor performs that step itself, and the two-update path is deliberate: migration
     * 0051's state machine allows `imported → pending_approval` and `pending_approval → posted`
     * but not `imported → posted`, so both transitions happen, in this transaction, in order.
     *
     * Refusing `imported` instead — which is what this did first — threw inside
     * `approvals.request`, unwinding the request row, its audit row and its events along with
     * it, and left the batch permanently stuck: COD already in the bank that could never be
     * posted, for exactly the small statements a threshold exists to wave through.
     */
    if (initial.status === 'imported') {
      const advanced = await repo.attachSettlementApproval(tx, {
        orgId: context.orgId,
        settlementId,
        approvalRequestId: approval.id,
      });
      if (!advanced) {
        throw new CourierError(
          'SETTLEMENT_TRANSITION_INVALID',
          'That settlement changed while it was being approved.',
        );
      }
    }

    const batch = await repo.settlementForUpdate(tx, context.orgId, settlementId);
    if (batch === undefined) {
      throw new CourierError('SETTLEMENT_NOT_FOUND', 'No such settlement.');
    }
    if (batch.status !== 'pending_approval') {
      throw new CourierError(
        'SETTLEMENT_TRANSITION_INVALID',
        `A ${batch.status} settlement cannot post.`,
      );
    }
    if (batch.approval_request_id !== approval.id) {
      /*
       * The batch names a different approval than the one being decided.
       *
       * Two batches of the same courier with the same matched gross are interchangeable as far
       * as the amount check below is concerned, so this is the check that binds *this* approval
       * to *this* batch. Migration 0052 says the same at the row, which is the layer that holds
       * when a future caller reaches the table another way.
       */
      throw new CourierError(
        'APPROVAL_REQUIRED',
        'That approval belongs to a different settlement.',
      );
    }
    /*
     * The amount a checker approved has to be the amount that posts (D-078).
     *
     * `approval.amountPoisha` is the frozen figure on the request; `matched_gross_poisha` is
     * the batch's. Migration 0051 checks the same equality, so this is the layer that gives a
     * sentence rather than a constraint name — and the layer that catches it before two
     * journals exist.
     */
    if (approval.amountPoisha !== BigInt(batch.matched_gross_poisha)) {
      throw new CourierError(
        'APPROVAL_REQUIRED',
        'The approved amount is not this settlement’s matched total.',
      );
    }

    const lines = await repo.settlementLines(tx, context.orgId, settlementId);
    const matchedLines = lines.filter((line) => line.match === 'matched');
    const consignmentIds = matchedLines
      .map((line) => line.consignment_id)
      .filter((id): id is string => id !== null);

    const posting = resolveSettlementPostingDate(
      toIsoDate(batch.settlement_date),
      await this.closedMonthStarts(tx, context.orgId),
    );

    const [receivable, charges, returns, wallet] = await Promise.all([
      this.requireAccount(tx, context.orgId, 'courier_receivable'),
      this.requireAccount(tx, context.orgId, 'courier_charges'),
      this.requireAccount(tx, context.orgId, 'return_charges'),
      this.wallets.walletAccount(tx, context.orgId, batch.wallet_id),
    ]);
    if (wallet === null) {
      throw new CourierError(
        'SETTLEMENT_FILE_INVALID',
        'This settlement’s wallet is no longer active.',
      );
    }

    const deliveryCharges = poisha(BigInt(batch.matched_delivery_charges_poisha));
    const returnCharges = poisha(BigInt(batch.matched_return_charges_poisha));
    const otherCharges = poisha(BigInt(batch.matched_other_charges_poisha));
    const net = poisha(BigInt(batch.matched_net_poisha));

    /*
     * The identity acceptance check 5 rests on, asserted before anything posts.
     *
     * charges + net must equal the gross the matched consignments owe. The domain's matcher
     * guarantees it row by row and the database's `settlements_matched_gross_is_charges_plus_net`
     * check guarantees it on the row — this is the third statement of it, at the moment it
     * matters, because both journals balance whatever the numbers are and a mismatch would be
     * invisible in the ledger. Its only symptom would be a courier receivable that never
     * reaches zero.
     */
    const relieved = settlementRelievesPoisha({
      deliveryChargesPoisha: deliveryCharges,
      returnChargesPoisha: returnCharges,
      otherChargesPoisha: otherCharges,
      netPoisha: net,
    });
    if (relieved !== BigInt(batch.matched_gross_poisha)) {
      throw new CourierError(
        'SETTLEMENT_FILE_INVALID',
        'This settlement’s charges and net do not add up to what the courier collected.',
      );
    }

    const actor = { orgId: context.orgId, userId: context.userId };
    let chargesJournalId: string | null = null;
    let cashJournalId: string | null = null;

    const totalCharges = deliveryCharges + returnCharges + otherCharges;
    if (totalCharges > 0n) {
      const posted = await this.ledger.post(
        tx,
        actor,
        courierChargesDraft({
          settlementId,
          postingDate: posting.postingDate,
          settlementDate: posting.settlementDate,
          courierReceivable: receivable,
          courierId: batch.courier_id,
          courierCharges: charges,
          returnCharges: returns,
          deliveryChargesPoisha: deliveryCharges,
          returnChargesPoisha: returnCharges,
          otherChargesPoisha: otherCharges,
          branchId: batch.branch_id,
          memo: batch.reference === null ? null : `Courier statement ${batch.reference}`,
        }),
      );
      chargesJournalId = posted.journalId;
    }

    if (net > 0n) {
      const posted = await this.ledger.post(
        tx,
        actor,
        codSettlementDraft({
          settlementId,
          postingDate: posting.postingDate,
          settlementDate: posting.settlementDate,
          courierReceivable: receivable,
          courierId: batch.courier_id,
          wallet,
          netPoisha: net,
          branchId: batch.branch_id,
          memo: batch.reference === null ? null : `Courier statement ${batch.reference}`,
        }),
      );
      cashJournalId = posted.journalId;
    }

    const marked = await repo.markSettlementPosted(tx, {
      orgId: context.orgId,
      settlementId,
      postingBusinessDate: posting.postingDate,
      deferred: posting.deferred,
      chargesJournalId,
      cashJournalId,
    });
    if (!marked) {
      throw new CourierError(
        'SETTLEMENT_TRANSITION_INVALID',
        'That settlement changed while it was being posted.',
      );
    }

    const linked = await repo.linkSettledConsignments(tx, {
      orgId: context.orgId,
      settlementId,
      consignmentIds,
      at: new Date(),
    });
    if (linked !== consignmentIds.length) {
      /*
       * Somebody settled one of these between the import and the approval.
       *
       * Thrown, so the whole approval transaction rolls back: the approval is not recorded,
       * the journals do not exist, and the batch stays `pending_approval`. Re-importing is
       * the fix, and it will find the consignment `already_settled` and list it as an
       * exception — which is exactly what the operator needs to see.
       */
      throw new CourierError(
        'SETTLEMENT_ALREADY_POSTED',
        'One of these consignments was settled by another statement; re-import this one.',
      );
    }

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: 'courier.settlement.posted',
      entityType: 'CourierSettlement',
      entityId: settlementId,
      before: { status: 'pending_approval' },
      after: {
        status: 'posted',
        approvalRequestId: approval.id,
        // D-037, visible in the audit trail: what the statement said, and where it posted.
        settlementDate: posting.settlementDate,
        postingBusinessDate: posting.postingDate,
        deferredFromClosedPeriod: posting.deferred,
        chargesJournalId,
        cashJournalId,
        consignmentsSettled: linked,
      },
    });
  };

  /** Close a batch without posting (§9's exceptions path). */
  async reject(
    context: ActiveContext,
    request: AuditableRequest,
    settlementId: string,
    input: { reason: string },
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const batch = await repo.settlementForUpdate(tx, context.orgId, settlementId);
      if (batch === undefined)
        throw new CourierError('SETTLEMENT_NOT_FOUND', 'No such settlement.');
      if (batch.status === 'posted') {
        // A posted settlement is corrected with a reversal, never by rejecting it
        // (invariant 2). Refused rather than quietly ignored.
        throw new CourierError(
          'SETTLEMENT_ALREADY_POSTED',
          'That settlement has posted; correct it with a reversal.',
        );
      }

      const ok = await repo.markSettlementRejected(tx, {
        orgId: context.orgId,
        settlementId,
        reason: input.reason,
      });
      if (!ok) {
        throw new CourierError('SETTLEMENT_TRANSITION_INVALID', 'That settlement changed.');
      }

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'courier.settlement.rejected',
        entityType: 'CourierSettlement',
        entityId: settlementId,
        before: { status: batch.status },
        after: { status: 'rejected', reason: input.reason },
        requestId: context.requestId,
        request,
      });

      return { settlementId, status: 'rejected' as const };
    });
  }

  async list(context: ActiveContext, filter: { status?: string; courierId?: string }) {
    const where = sql`
      (${filter.status ?? null}::text is null or status::text = ${filter.status ?? null})
      and (${filter.courierId ?? null}::uuid is null or courier_id = ${filter.courierId ?? null}::uuid)
    `;
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listSettlements(tx, context.orgId, where)).map((row) => view(row)),
    }));
  }

  /** One batch with every row, or with only the exceptions (§9's exceptions report). */
  async get(
    context: ActiveContext,
    settlementId: string,
    options: { exceptionsOnly?: boolean } = {},
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const batch = await repo.settlementById(tx, context.orgId, settlementId);
      if (batch === undefined)
        throw new CourierError('SETTLEMENT_NOT_FOUND', 'No such settlement.');
      const lines = await repo.settlementLines(tx, context.orgId, settlementId, {
        exceptionsOnly: options.exceptionsOnly ?? false,
      });
      return {
        ...view(batch),
        lines: lines.map((line) => ({
          id: line.id,
          rowNo: line.row_no,
          consignmentNo: line.consignment_no,
          reference: line.reference,
          match: line.match,
          consignmentId: line.consignment_id,
          orderId: line.order_id,
          codCollectedPoisha: line.cod_collected_poisha,
          deliveryChargePoisha: line.delivery_charge_poisha,
          returnChargePoisha: line.return_charge_poisha,
          otherChargePoisha: line.other_charge_poisha,
          netPoisha: line.net_poisha,
          expectedPoisha: line.expected_poisha,
          note: line.note,
        })),
      };
    });
  }

  /**
   * Which months are closed, for D-037's resolution.
   *
   * A read of `ledger.periods`, which is the ledger's table — so it would belong on a port
   * if the ledger did not already own the *enforcement*: posting into a closed period is
   * refused by migration 0014's period-lock trigger whatever this returns. This read only
   * decides *where* to post, so a stale answer produces a `PERIOD_CLOSED` from the ledger
   * rather than a wrong journal. The INTEGRATION notes ask for it on `ledger.api.ts` all the
   * same, because a second reader of another module's table is a second thing to update when
   * D-093's locking rule changes.
   */
  private async closedMonthStarts(tx: Tx, orgId: string): Promise<IsoDate[]> {
    const rows = await tx.execute<{ starts_on: string }>(sql`
      select starts_on::text as starts_on from ledger.periods
      where org_id = ${orgId} and status = 'closed'
      order by starts_on
    `);
    return [...rows].map((row) => toIsoDate(row.starts_on));
  }

  private async requireAccount(
    tx: Tx,
    orgId: string,
    subtype: 'courier_receivable' | 'courier_charges' | 'return_charges',
  ) {
    const account = await this.accounts.accountBySubtype(tx, orgId, subtype);
    if (account === null) {
      // Seeded by the chart-of-accounts template (D-084). Missing means the chart is broken,
      // and saying so beats posting the value somewhere else.
      throw new CourierError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        `This organization has no ${subtype} account.`,
      );
    }
    return account;
  }

  private adapterContext(orgId: string, account: repo.CourierAccountRow) {
    const credentials: Record<string, string> = {};
    if (account.credentials !== null) {
      Object.assign(
        credentials,
        openCredentials(account.credentials, {
          orgId,
          accountId: account.courier_id,
          field: 'credentials',
        }),
      );
    }
    return {
      credentials,
      baseUrl: account.base_url,
      mode: account.mode,
      timeoutMs: courierEnv().COURIER_HTTP_TIMEOUT_MS,
    };
  }
}

/** The batch, as a response. Every amount a decimal string (§23, invariant 1). */
function view(row: repo.SettlementRow) {
  return {
    id: row.id,
    courierId: row.courier_id,
    courierAccountId: row.courier_account_id,
    reference: row.reference,
    /** D-037's reference field: what the courier's statement itself is dated. */
    settlementDate: row.settlement_date,
    /** Where the journals landed. Differs when the statement's month was closed (D-037). */
    postingBusinessDate: row.posting_business_date,
    deferredFromClosedPeriod: row.deferred_from_closed_period,
    status: row.status,
    walletId: row.wallet_id,
    fileObjectId: row.file_object_id,
    fileGrossPoisha: row.file_gross_poisha,
    fileChargesPoisha: row.file_charges_poisha,
    fileNetPoisha: row.file_net_poisha,
    fileRowCount: row.file_row_count,
    matchedGrossPoisha: row.matched_gross_poisha,
    matchedChargesPoisha: row.matched_charges_poisha,
    matchedDeliveryChargesPoisha: row.matched_delivery_charges_poisha,
    matchedReturnChargesPoisha: row.matched_return_charges_poisha,
    matchedOtherChargesPoisha: row.matched_other_charges_poisha,
    matchedNetPoisha: row.matched_net_poisha,
    matchedRowCount: row.matched_row_count,
    exceptionCount: row.exception_count,
    approvalRequestId: row.approval_request_id,
    chargesJournalId: row.charges_journal_id,
    cashJournalId: row.cash_journal_id,
    importedBy: row.imported_by,
    postedAt: row.posted_at,
    rejectedReason: row.rejected_reason,
  };
}
