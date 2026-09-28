import { Inject, Injectable } from '@nestjs/common';
import type { AbilityContext } from '@elysium/contracts';
import type { Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { FraudService, type FraudBadge, type FraudGateDecision } from './fraud.service.js';

/**
 * Fraud's service interface for other modules (invariant 12).
 *
 * One consumer today and it is the important one: the order desk's confirm (M10/M11).
 * §9's state machine already knows about a fraud decision — `TransitionRequest` carries
 * `fraudDecision` and `fraudOverrideReason`, and `ORDER_FRAUD_BLOCKED` is already in
 * `packages/contracts/src/errors.ts` — so what the orders module needs from here is the
 * *value* of those two fields and the audited record behind them.
 *
 * ## The shape, and why it is this shape
 *
 * The orders module owns the port. It declares
 * `apps/server/src/modules/orders/ports/fraud-gate.port.ts` with a `FRAUD_GATE` symbol
 * and a `FraudGate` interface, and it depends on **that** rather than on this file —
 * which is what lets the order desk be built, tested and shipped with a fake gate before
 * this module exists, and lets this module change without touching it.
 *
 * `FraudApiService` is written to satisfy that interface structurally. Its exact text,
 * ready to paste into the port file, is in the INTEGRATION notes for this milestone, and
 * `FraudGateContract` below is the same shape declared here so a drift between the two
 * is a compile error in this module rather than a runtime surprise in that one.
 *
 * ## Every method joins the caller's transaction
 *
 * `assertConfirmAllowed` writes `fraud.order_phones`, may write `fraud.overrides`, and
 * writes the audit row — all inside the `withOrg()` transaction that is confirming the
 * order. That is the property check 5 rests on: an order cannot confirm past a block
 * without the override record committing with it, because there is only one transaction
 * and it either commits or does not.
 */

/**
 * The port the orders module declares, restated here.
 *
 * Deliberately a *copy* rather than an import. Importing
 * `../orders/ports/fraud-gate.port.js` would make this module depend on the orders
 * module, and a cycle between two modules' service interfaces is how invariant 12 stops
 * meaning anything. Two declarations of one contract is the cost of the arrow pointing
 * one way, and the cost is bounded: the orders module's compile fails the moment its
 * port and this class disagree, which is the check that matters.
 */
export interface FraudGateContract {
  assertConfirmAllowed(tx: Tx, input: ConfirmGateInput): Promise<FraudGateDecision>;
}

export interface ConfirmGateInput {
  readonly orgId: string;
  readonly orderId: string;
  /** Any spelling `normalizeBdPhone` accepts. Hashed inside; never stored or logged. */
  readonly phone: string;
  readonly actor: AbilityContext;
  /** An org_admin's reason for confirming past a `block`. Audited (check 5). */
  readonly overrideReason?: string | null;
  /** The request, so the audit interceptor's net stands down for an entry we wrote. */
  readonly request?: AuditableRequest;
}

export interface FraudApi extends FraudGateContract {
  /**
   * The badge for a phone number, with its reasons (M13: "the badge and its reasons").
   *
   * For the order desk's phone lookup, before an order exists. Counts and a score; never
   * a hash, never another brand's order data (check 2).
   */
  badgeFor(tx: Tx, input: { readonly orgId: string; readonly phone: string }): Promise<FraudBadge>;

  /**
   * Score a number *and* remember which order it was scored for.
   *
   * The remembering is what keeps the cross-org counters maintainable without this
   * module reading `sales.orders` — see `fraud.order_phones` in the schema.
   */
  badgeForOrder(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly phone: string },
  ): Promise<FraudBadge>;

  /**
   * Emit `order.fraud_flagged` for a verdict worth telling somebody about.
   *
   * Separate from the assessment because only the orders module knows the order number,
   * and §19's payload carries it. Returns false for an `allow`, which is emitted for
   * nobody: an event per confirmed order would be a live feed of nothing.
   */
  announce(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly orderNo: string;
      readonly badge: FraudBadge;
    },
  ): Promise<boolean>;
}

export const FRAUD_API = Symbol('FRAUD_API');

/**
 * The symbol the orders module injects.
 *
 * Declared here as well, with the same description, so that the provider registration in
 * `app.module.ts` can bind both tokens to this one class. The orders module must not
 * import `FRAUD_API` — that would be a compile-time dependency on this module, which is
 * the thing the port exists to avoid — so the two symbols are distinct objects bound to
 * one instance.
 */
export const FRAUD_GATE = Symbol('FRAUD_GATE');

@Injectable()
export class FraudApiService implements FraudApi {
  constructor(@Inject(FraudService) private readonly fraud: FraudService) {}

  async assertConfirmAllowed(tx: Tx, input: ConfirmGateInput): Promise<FraudGateDecision> {
    return this.fraud.assertConfirmAllowed(tx, {
      orgId: input.orgId,
      orderId: input.orderId,
      phone: input.phone,
      actor: input.actor,
      ...(input.overrideReason === undefined ? {} : { overrideReason: input.overrideReason }),
      ...(input.request === undefined ? {} : { request: input.request }),
    });
  }

  async badgeFor(
    tx: Tx,
    input: { readonly orgId: string; readonly phone: string },
  ): Promise<FraudBadge> {
    return this.fraud.assess(tx, input);
  }

  async badgeForOrder(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly phone: string },
  ): Promise<FraudBadge> {
    return this.fraud.assessForOrder(tx, input);
  }

  async announce(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly orderNo: string;
      readonly badge: FraudBadge;
    },
  ): Promise<boolean> {
    return this.fraud.announce(tx, input);
  }
}

export type { FraudBadge, FraudGateDecision };
