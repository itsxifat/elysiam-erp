import type { AbilityContext } from '@elysium/contracts';
import type { Tx } from '@elysium/db';
import type { FraudDecision } from '@elysium/domain';

import type { AuditableRequest } from '../../../platform/audit/audit.interceptor.js';

/**
 * The one thing §10's fraud engine gets to say about a confirm (architecture §9, §10).
 *
 * M13 owns the trust score, the phone-hash history and the decision bands. This module
 * owns the transition. The two meet here, in a port this module declares and M13
 * implements — deliberately the wrong way round from the obvious design, where orders
 * would import `modules/fraud`.
 *
 * Two reasons, and the second is the one that matters:
 *
 * * **Orders has to work without a fraud engine.** The default provider in
 *   `orders.module.ts` allows everything, so M10 ships and is testable before M13 exists.
 *   An import of a module that is not in the tree is not a dependency, it is a build
 *   failure.
 * * **The gate cannot grow.** The interface has one method and takes only what a decision
 *   is allowed to be made from. In particular it takes the **actor's ability context**,
 *   not a `canOverride` boolean: §6's matrix is the single source of truth for who may
 *   override a block (`update FraudOverride`, org_admin alone), and a boolean would let
 *   any caller assert its way past it.
 *
 * ## Why the shape is M13's shape
 *
 * `apps/server/src/modules/fraud/fraud.api.ts` restates this contract as
 * `FraudGateContract` and is written to satisfy it structurally, so integration is one
 * provider binding and no negotiation. The duplication is the cost of the arrow pointing
 * one way, and it is bounded: either side's compile fails the moment the two disagree.
 *
 * The verdict below is deliberately **narrower** than what M13 returns. A `FraudGateVerdict`
 * is what this module stores on the order — `trust_score` and `fraud_decision`, which §9's
 * state machine reads — and nothing else. The badge's reasons, provider breakdown and
 * cross-org counts are M13's to serve to the desk through its own endpoint, where §6's
 * `read FraudSignal` governs them; pulling them through here would put another module's
 * data inside an order response with no ability of its own.
 *
 * The domain state machine refuses a confirm on a `block` decision that carries no
 * override reason, reading the column as it stands. This port is the *live* check, and it
 * runs first: the buyer may have been blocked after the order was taken, and the verdict
 * it returns is what the column is set to before the machine is asked.
 */

export interface FraudGateInput {
  readonly orgId: string;
  readonly orderId: string;
  /**
   * The buyer's number, in any spelling `normalizeBdPhone` accepts.
   *
   * Hashed by the engine and never stored or logged in the clear (D-032, invariant 10).
   * Passed rather than looked up because the engine may not read `sales.customers`
   * (invariant 12), and the order is the thing being confirmed.
   */
  readonly phone: string;
  /** Who is confirming, so §6 decides who may override rather than this module. */
  readonly actor: AbilityContext;
  /** An org_admin's reason for confirming past a `block` (§10). Audited. */
  readonly overrideReason?: string | null;
  /** The request, so the audit interceptor's net stands down for an entry the gate wrote. */
  readonly request?: AuditableRequest;
}

/** What the orders module keeps: the two columns §9's machine reads, and how they got there. */
export interface FraudGateVerdict {
  /** 0–100, integer. `orders.trust_score` has a CHECK that says so. */
  readonly trustScore: number;
  readonly decision: FraudDecision;
  /** True when a `block` was confirmed anyway, with a reason (§10, check 5). */
  readonly overridden: boolean;
  readonly overrideId: string | null;
}

export interface FraudGate {
  /**
   * Allow this confirm, or throw.
   *
   * Runs inside the confirm's own transaction and **before any stock is reserved**, so a
   * refusal leaves nothing behind — a gate consulted afterwards would hold units for an
   * order it is about to refuse, and only the rollback would release them.
   *
   * Throws with the contract code `ORDER_FRAUD_BLOCKED`, so the API answers 403 with a
   * code a client can branch on. An implementation that needed to call an external service
   * enqueues a job and decides from what it already holds: invariant 6 applies to it
   * exactly as it applies here.
   */
  assertConfirmAllowed(tx: Tx, input: FraudGateInput): Promise<FraudGateVerdict>;
}

/** The Nest injection token for `FraudGate`. */
export const FRAUD_GATE = Symbol('FraudGate');

/**
 * The permissive default, registered by `OrdersModule` until M13 replaces it.
 *
 * Named and exported rather than written as an inline `useValue`, so a test can assert
 * which gate is installed — "orders confirmed fine, so the fraud gate must be wired" is
 * exactly the reasoning that hides a gate silently replaced by this one.
 *
 * It returns `allow` at 100 rather than a null verdict, because the order's columns are
 * written from whatever comes back and a null there would read as "not yet assessed" on a
 * system that has no assessment to make.
 */
export class AllowAllFraudGate implements FraudGate {
  assertConfirmAllowed(): Promise<FraudGateVerdict> {
    return Promise.resolve({
      trustScore: 100,
      decision: 'allow',
      overridden: false,
      overrideId: null,
    });
  }
}
