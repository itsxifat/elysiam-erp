/**
 * Maker-checker rules (architecture §6, invariant 11).
 *
 * Pure, so the question "does this need approval" has one answer that is the
 * same in the API, in a job, in a preview screen and in a test. The moment the
 * rule lives inside a service, the preview and the enforcement can disagree —
 * and the direction they disagree in is always the expensive one.
 */

export type Poisha = bigint;

/** A threshold, per org per action type. Absent means "not configured". */
export interface Threshold {
  readonly type: string;
  readonly thresholdPoisha: Poisha;
}

export interface ApprovalDecisionInput {
  readonly type: string;
  /** Null for an action with no money attached — a period reopen, say. */
  readonly amountPoisha: Poisha | null;
  readonly thresholds: readonly Threshold[];
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
 * Is this amount within an amount-limited checker's authority (§6)?
 *
 * §6's checker cell for branch_manager reads "branch items **under
 * threshold**", and the last two words decide whether a showroom manager can
 * sign off a write-off of any size. The limit is the org's own threshold for
 * the type — the same number that decides whether a second person is needed —
 * so a branch keeps the small things and anything at or above it goes up.
 *
 * Both edge cases fail closed, and for the same reason `requiresApproval`
 * does: a request with no amount has no number to be under, and an org with no
 * threshold configured has not said what "small" means. In both cases the
 * limited checker may decide nothing and an org-level checker still can, so
 * the failure is an inconvenience rather than an unapproved payment.
 */
export function withinCheckerLimit(input: {
  readonly amountPoisha: Poisha | null;
  readonly thresholdPoisha: Poisha | null;
}): { readonly ok: boolean; readonly reason?: string } {
  if (input.amountPoisha === null) {
    return { ok: false, reason: 'A request with no amount needs an organization-level checker.' };
  }
  if (input.thresholdPoisha === null) {
    return {
      ok: false,
      reason: 'No approval threshold is configured for this type, so it needs a wider checker.',
    };
  }

  // Magnitude, for the same reason requiresApproval uses it: a negative
  // adjustment of 50,000 poisha moves exactly as much as a positive one.
  const magnitude = input.amountPoisha < 0n ? -input.amountPoisha : input.amountPoisha;
  if (magnitude >= input.thresholdPoisha) {
    return { ok: false, reason: 'This amount is above your approval limit.' };
  }
  return { ok: true };
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
