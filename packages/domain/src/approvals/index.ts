/**
 * Maker-checker rules (architecture §6, invariant 11).
 *
 * Pure, so the question "does this need approval" has one answer that is the
 * same in the API, in a job, in a preview screen and in a test. The moment the
 * rule lives inside a service, the preview and the enforcement can disagree —
 * and the direction they disagree in is always the expensive one.
 */

/**
 * Plain `bigint` poisha: thresholds and request amounts arrive from the
 * database and the wire already validated, and are only compared, never
 * computed with. Arithmetic goes through the branded `Poisha` in `../money`.
 */
type Amount = bigint;

/** A threshold, per org per action type. Absent means "not configured". */
export interface Threshold {
  readonly type: string;
  readonly thresholdPoisha: Amount;
}

export interface ApprovalDecisionInput {
  readonly type: string;
  /** Null for an action with no money attached — a period reopen, say. */
  readonly amountPoisha: Amount | null;
  readonly thresholds: readonly Threshold[];
  /**
   * True when no threshold may exempt this request: a control type (D-071), or
   * an amount the requester typed where the owning module should have derived
   * it (D-072). The caller decides which; this only obeys.
   */
  readonly alwaysRequired?: boolean;
}

/**
 * Does this action need a second person?
 *
 * Three rules, and the third is the one that matters:
 *
 * 1. At or above the threshold: yes. "Above" alone would let an org set a
 *    threshold of exactly the amount someone routinely moves and never be
 *    asked — the boundary belongs on the safe side.
 * 2. Below it: no.
 * 3. **No threshold configured: yes.** Fail closed. The alternative is that
 *    forgetting to configure a threshold silently switches maker-checker off
 *    for that action, which is indistinguishable from it working until an
 *    audit finds a year of unapproved wallet adjustments.
 *
 * An action with no amount always needs approval: there is no number to
 * compare, and every amount-less type in §6's list is a control action.
 */
export function requiresApproval(input: ApprovalDecisionInput): boolean {
  if (input.alwaysRequired === true) return true;
  const threshold = input.thresholds.find((entry) => entry.type === input.type);
  if (threshold === undefined) return true;
  if (input.amountPoisha === null) return true;

  // Compare on magnitude: a refund or a negative adjustment of 50,000 poisha
  // is exactly as material as a payment of 50,000, and signing the comparison
  // would wave every negative amount straight through.
  const magnitude = input.amountPoisha < 0n ? -input.amountPoisha : input.amountPoisha;
  return magnitude >= threshold.thresholdPoisha;
}

/**
 * Does this payment need a second person once the same person's earlier ones today count?
 * (M30's C7, D-415)
 *
 * A threshold compared with one payment at a time is a threshold anyone can step under by
 * paying in pieces: five payments of 9,000 to the same supplier where the brand asks a
 * checker to look at 10,000. So the amount compared is this payment plus what the same
 * person already moved under the same rule today without a checker — the owning module
 * says which entries those are and sums them (`earlierTodayPoisha`, never negative).
 *
 * `heldByDayTotal` is true when the payment alone would have passed: the module raises
 * such a request as held whatever the threshold says by then (`holdForChecker`), because
 * the approvals service compares one amount, and would otherwise wave it through.
 *
 * Entries a checker approved do not count towards the day: a second person has already
 * looked at them, and counting them would hold every later payment of the day too.
 */
export function requiresApprovalForDay(
  input: ApprovalDecisionInput & { readonly earlierTodayPoisha: Amount },
): { readonly required: boolean; readonly heldByDayTotal: boolean } {
  const alone = requiresApproval(input);
  if (alone || input.amountPoisha === null) return { required: alone, heldByDayTotal: false };

  const earlier = input.earlierTodayPoisha < 0n ? 0n : input.earlierTodayPoisha;
  const magnitude = input.amountPoisha < 0n ? -input.amountPoisha : input.amountPoisha;
  const withDay = requiresApproval({ ...input, amountPoisha: magnitude + earlier });
  return { required: withDay, heldByDayTotal: withDay };
}

/**
 * Can this person decide this request?
 *
 * The database has the same rule as a CHECK constraint, which is what actually
 * enforces it. This exists so the API can say why, rather than surfacing a
 * constraint violation to someone who has done nothing unusual.
 */
export function canDecide(input: {
  readonly requestedBy: string;
  readonly decidedBy: string;
  readonly status: string;
}): { readonly ok: boolean; readonly reason?: string } {
  if (input.status !== 'pending') {
    return { ok: false, reason: 'This request has already been decided.' };
  }
  if (input.requestedBy === input.decidedBy) {
    return { ok: false, reason: 'The person who requested an action cannot approve it.' };
  }
  return { ok: true };
}
