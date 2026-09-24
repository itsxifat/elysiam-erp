import type { Tx } from '@elysium/db';
import type { JournalDraft } from '@elysium/domain';

/**
 * The ledger's service interface for other modules (invariant 12).
 *
 * Every module that moves money — supply, delivery, POS, payroll, payouts —
 * posts through this and never touches `ledger.*` tables itself. The call
 * joins the caller's own `withOrg()` transaction, so the business change and
 * its journal commit together or not at all.
 *
 * `post` and `reverse` write no audit row: the caller writes one, in the same
 * transaction, for the business event it posted (`AuditService.record`). Cash
 * in, period close and reopen do; every future caller must too (audit N9).
 */

/** Who is posting, for `created_by` and the audit trail. */
export interface LedgerActor {
  readonly orgId: string;
  readonly userId: string;
}

export interface PostResult {
  readonly journalId: string;
  /** False when the idempotency key had already been posted: nothing was written. */
  readonly created: boolean;
  readonly businessDate: string;
}

export interface LedgerApi {
  /**
   * Post a journal built by a posting rule in `packages/domain/src/posting`.
   *
   * Idempotent: the same key posted again returns the first journal and
   * writes nothing. The same key with *different* content is refused with
   * `IDEMPOTENCY_CONFLICT` (D-082). Refuses a closed period (`PERIOD_CLOSED`),
   * an inactive or foreign account, and anything `validateJournalDraft`
   * refuses. The database checks balance again at commit.
   */
  post(tx: Tx, actor: LedgerActor, draft: JournalDraft): Promise<PostResult>;

  /**
   * Undo a posted journal with a reversal journal dated today (Asia/Dhaka),
   * the only correction the ledger allows (invariant 2). Reversing twice
   * returns the first reversal; a reversal cannot itself be reversed.
   */
  reverse(
    tx: Tx,
    actor: LedgerActor,
    journalId: string,
    reason: string,
    at?: Date,
  ): Promise<PostResult>;
}

/** The Nest injection token for `LedgerApi`. */
export const LEDGER_API = Symbol('LedgerApi');
