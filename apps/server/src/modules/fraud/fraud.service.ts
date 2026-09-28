import { Injectable } from '@nestjs/common';
import { defineAbilityFor, type AbilityContext } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { normalizeBdPhone } from '@elysium/domain';
import {
  assertBands,
  DEFAULT_FRAUD_BANDS,
  trustScore,
  type FraudBands,
  type TrustAssessment,
  type TrustReason,
} from '@elysium/domain/fraud';
import type { Logger } from 'pino';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { emit } from '../../platform/events/outbox.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { FraudError } from './fraud.errors.js';
import { FRAUD_REFRESH_QUEUE, type RefreshProviderPayload } from './fraud.queues.js';
import * as repo from './fraud.repository.js';
import { PhoneHashService } from './phone-hash.js';
import type { ProviderSignalCounts } from './providers/fraud-signal.provider.js';
import { ProviderGateway } from './providers/provider-gateway.js';

/**
 * The fraud check (architecture §5 exception 1, §10; M13).
 *
 * ## What leaves this service
 *
 * A badge: a score, a decision, reason codes, and the cross-org **counts** behind
 * them. Nothing else, and in particular never the phone hash. The hash is a stable
 * identifier for one person across all five brands, and handing it to a client would
 * turn every API response into a correlation key — the one thing the hashing was for.
 * Acceptance check 2 asserts this from the outside, as an adversarial test, because a
 * comment is not a control.
 *
 * ## No provider call inside a transaction (invariant 6)
 *
 * `assess()` reads the cached rows and scores them. When a provider answer is missing
 * or past its TTL it **enqueues a refresh job in the same transaction** and returns the
 * score it has. §10 asks for exactly this — "shows the badge within 300 ms from cache
 * and refreshes stale data in the background" — and invariant 6 requires it: holding a
 * database connection open across a courier's network is how their slow afternoon
 * becomes our outage.
 *
 * The consequence worth stating: the first ever lookup of a number has no provider data
 * and the badge says so. That is the design, not a gap. A synchronous first fetch would
 * put a third party's latency on the confirm path, which is the shape check 3 exists to
 * rule out.
 */
@Injectable()
export class FraudService {
  /**
   * Built on first use, not in the constructor.
   *
   * `createLogger` reads `serverEnv()`, which parses the whole server environment — so a
   * logger created in the constructor makes this service unconstructable without
   * `AUTH_SECRET`, `APP_DOMAIN` and the rest. That is fine inside the API and wrong
   * everywhere else: the benchmark for check 4 constructs these classes directly, on
   * purpose, because §10's budget is about the badge rather than about a loopback socket.
   * Two log lines should not drag an HTTP application's configuration into a measurement.
   */
  private cachedLogger: Logger | undefined;

  constructor(
    private readonly hasher: PhoneHashService,
    private readonly providers: ProviderGateway,
    private readonly audit: AuditService,
  ) {}

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('fraud');
    return this.cachedLogger;
  }

  /** One org's bands, falling back to D-011's defaults when it has no row. */
  async bandsFor(tx: Tx, orgId: string): Promise<{ bands: FraudBands; rules: repo.OrgRulesRow }> {
    const row = await repo.readRules(tx, orgId);
    if (row === null) {
      return {
        bands: DEFAULT_FRAUD_BANDS,
        rules: {
          ...DEFAULT_FRAUD_BANDS,
          // Providers are opt-in per org: the lookups are metered, and five brands are
          // five companies with five budgets.
          providerEnabled: false,
          // §10's 72 hours.
          providerTtlMinutes: 4_320,
        },
      };
    }

    const bands = {
      allowMin: row.allowMin,
      warnMin: row.warnMin,
      requireAdvanceMin: row.requireAdvanceMin,
    };
    // A row that predates a stricter rule here must fail loudly rather than quietly
    // collapse `block` into `require_advance`. The database has the same check (0045),
    // so reaching this throw means the constraint was dropped.
    assertBands(bands);
    return { bands, rules: row };
  }

  /**
   * Score one phone number for one org.
   *
   * Takes the caller's transaction, so the badge, the `order_phones` row and any audit
   * entry commit together. Returns the assessment plus the counts, ready to serialise.
   */
  async assess(
    tx: Tx,
    input: { readonly orgId: string; readonly phone: string },
  ): Promise<FraudBadge> {
    const phoneHash = this.hasher.hash(input.phone);
    const { bands, rules } = await this.bandsFor(tx, input.orgId);

    const signals = await repo.readSignals(tx, phoneHash);
    const cached = rules.providerEnabled
      ? await repo.readProviderChecks(tx, phoneHash, rules.providerTtlMinutes)
      : [];

    /*
     * Three states, and the badge has to distinguish them (check 3):
     *
     * - providers off for this org, or none configured in this deployment → the score
     *   is internal by design and says nothing about providers;
     * - providers on and a fresh row for every one of them → available;
     * - providers on and a row missing or stale → unavailable, plus a refresh job.
     */
    const expected = rules.providerEnabled ? this.providers.names : [];
    const missing = expected.filter((name) => !cached.some((row) => row.provider === name));
    const providerAvailable = expected.length === 0 || missing.length === 0;

    if (missing.length > 0) {
      await this.scheduleRefresh(tx, {
        orgId: input.orgId,
        phone: input.phone,
        providers: missing,
      });
    }

    const assessment = trustScore({
      internal: signals ?? {
        ordersTotal: 0,
        delivered: 0,
        returned: 0,
        cancelled: 0,
        lastIncidentAt: null,
        manualFlagCount: 0,
      },
      providers: cached.map((row) => ({
        provider: row.provider,
        total: row.total,
        delivered: row.delivered,
        returnedOrCancelled: row.returnedOrCancelled,
      })),
      providerAvailable,
      bands,
      now: new Date(),
    });

    return {
      trustScore: assessment.score,
      decision: assessment.decision,
      reasons: assessment.reasons,
      providerAvailable: assessment.providerAvailable,
      bands,
      /*
       * Counts, which check 2 explicitly permits an org to see ("org B sees counts
       * only"). Never a hash, never a brand, never an order — the row they come from has
       * no column for any of those (migration 0045).
       */
      signals:
        signals === null
          ? null
          : {
              ordersTotal: signals.ordersTotal,
              delivered: signals.delivered,
              returned: signals.returned,
              cancelled: signals.cancelled,
              lastIncidentAt: signals.lastIncidentAt?.toISOString() ?? null,
              manualFlagCount: signals.manualFlagCount,
            },
      providers: cached.map((row) => ({
        name: row.provider,
        total: row.total,
        delivered: row.delivered,
        returnedOrCancelled: row.returnedOrCancelled,
        fetchedAt: row.fetchedAt.toISOString(),
      })),
      assessedAt: new Date().toISOString(),
    };
  }

  /**
   * Score a number and remember which order it was scored for.
   *
   * The `order_phones` row is what keeps invariant 12 intact: `order.status_changed`
   * carries an id and a status and never a phone number, so without this row the
   * subscriber that maintains the cross-org counters would have to read `sales.orders`.
   */
  async assessForOrder(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly phone: string },
  ): Promise<FraudBadge> {
    const badge = await this.assess(tx, { orgId: input.orgId, phone: input.phone });
    await repo.rememberOrderPhone(tx, {
      orgId: input.orgId,
      orderId: input.orderId,
      phoneHash: this.hasher.hash(input.phone),
    });
    return badge;
  }

  /**
   * Enqueue a provider refresh, and never fail the caller for it.
   *
   * The `catch` is deliberate and it is the one place in this module that swallows
   * something. A fraud check is an *advisory* on an order; a queue that is not
   * registered, or a pg-boss runtime that is not running in this process, must not stop
   * an agent taking a customer's order. So the failure is logged with the queue name —
   * never the number, never the hash (invariant 10) — and the badge goes out marked
   * internal-only, which is a state the desk already renders (check 3).
   *
   * This is a different judgement from the one in `fraud.config.ts`, where a missing
   * hash key stops the process. The distinction is recoverability: an unsent refresh
   * job costs one stale badge and the next lookup tries again, while a wrong hash key
   * corrupts five brands' history in a way no migration can repair.
   */
  private async scheduleRefresh(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly phone: string;
      readonly providers: readonly string[];
    },
  ): Promise<void> {
    const payload: RefreshProviderPayload = {
      // The plaintext number, because a provider has to look it up and a hash cannot be
      // reversed. `pgboss.job` is not readable by the application role's tenant
      // queries, the payload is not logged, and the row is deleted on completion —
      // which is why the job carries the number and the tables never do.
      phone: input.phone,
      providers: [...input.providers],
    };

    try {
      await enqueue(tx, FRAUD_REFRESH_QUEUE.name, payload, {
        orgId: input.orgId,
        /*
         * One in-flight refresh per number per org. Without it, ten agents looking at
         * the same buyer during a flash sale enqueue ten identical metered lookups. The
         * key is the hash, so the number never appears in `pgboss.job`'s indexed
         * columns.
         */
        singletonKey: `fraud:${this.hasher.hash(input.phone)}`,
      });
    } catch (error) {
      this.logger.warn(
        { queue: FRAUD_REFRESH_QUEUE.name, err: error instanceof Error ? error.name : 'unknown' },
        'could not enqueue a fraud provider refresh; the badge is internal-only',
      );
    }
  }

  /**
   * Fetch from every named provider and store what came back.
   *
   * Called by the worker's job handler, **outside** any business transaction (invariant
   * 6): the network call happens first, then a short `withOrg` writes the rows.
   *
   * `unavailable` writes nothing, on purpose. Storing a zero row would read as "this
   * buyer has a clean record" for the whole TTL, which is the worst possible way for a
   * fraud signal to fail — and it would also suppress the next refresh, so one timeout
   * would blind the check for three days.
   */
  async refreshProviders(
    orgId: string,
    input: { readonly phone: string; readonly providers: readonly string[] },
  ): Promise<{ readonly fetched: number; readonly unavailable: readonly string[] }> {
    const phoneHash = this.hasher.hash(input.phone);
    // Normalised before it reaches an adapter, so every provider is asked about the same
    // number the hash was computed from. An adapter converting to its own national form
    // is fine; an adapter *guessing* at the country code is not.
    const e164 = normalizeBdPhone(input.phone);

    const results = await this.providers.lookupAll(e164);

    const unavailable: string[] = [];
    const ok: { readonly name: string; readonly counts: ProviderSignalCounts }[] = [];

    for (const [name, result] of results) {
      if (!input.providers.includes(name)) continue;
      if (result.status === 'ok') ok.push({ name, counts: result.counts });
      else unavailable.push(`${name}:${result.reason}`);
    }

    if (ok.length > 0) {
      await withOrg({ orgId }, async (tx) => {
        for (const entry of ok) {
          await repo.upsertProviderCheck(tx, {
            phoneHash,
            provider: entry.name,
            total: entry.counts.total,
            delivered: entry.counts.delivered,
            returnedOrCancelled: entry.counts.returnedOrCancelled,
            ratio: entry.counts.ratio,
            raw: entry.counts.raw,
          });
        }
      });
    }

    if (unavailable.length > 0) {
      // The codes, never the provider's own error text: those quote the request, and the
      // request is a phone number (invariant 10).
      this.logger.info({ unavailable }, 'fraud provider lookup did not answer');
    }

    return { fetched: ok.length, unavailable };
  }

  /**
   * Apply one order outcome to the cross-org counters.
   *
   * Idempotency is the caller's problem, and the caller is the outbox subscriber, which
   * the dispatcher runs at least once. See the note there: `order.status_changed` rows
   * are unique per transition, so the subscriber dedupes on the event and this stays a
   * plain increment.
   */
  async applyOutcome(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly outcome: repo.OrderOutcome;
      readonly at: Date;
    },
  ): Promise<boolean> {
    const phoneHash = await repo.findOrderPhone(tx, input.orgId, input.orderId);
    if (phoneHash === null) {
      /*
       * No mapping, so this order never went through the confirm guard — a landing-page
       * order that was cancelled before anyone looked at it, or an order created while
       * the fraud flag was off. Nothing to count, and inventing a row would mean
       * guessing which number it was.
       */
      return false;
    }

    await repo.applyOrderOutcome(tx, { phoneHash, outcome: input.outcome, at: input.at });
    return true;
  }

  /**
   * The confirm guard (M13, §9, §10, check 5).
   *
   * The refusal and the override are one function, because they are one decision: a
   * `block` that nobody overrides throws, and a `block` that an org_admin overrides
   * writes the reason to the audit log *and* to `fraud.overrides` inside the caller's
   * transaction. Splitting them would allow the order to confirm on one path and the
   * override record to be written on another, which is the state where the books say a
   * blocked order shipped and nothing says who allowed it.
   *
   * Only `block` stops a confirm. `warn` and `require_advance` change what the desk
   * shows and what it collects — that is the order module's business, which is why they
   * come back in the result rather than as an exception.
   */
  async assertConfirmAllowed(tx: Tx, input: AssertConfirmAllowedInput): Promise<FraudGateDecision> {
    const badge = await this.assessForOrder(tx, {
      orgId: input.orgId,
      orderId: input.orderId,
      phone: input.phone,
    });

    if (badge.decision !== 'block') {
      return { ...badge, overridden: false, overrideId: null };
    }

    const reason = (input.overrideReason ?? '').trim();

    if (reason === '') {
      throw new FraudError(
        'ORDER_FRAUD_BLOCKED',
        'This buyer is blocked by the fraud rules. An org admin can confirm anyway with a reason.',
      );
    }

    /*
     * The ability is derived from the actor's roles here rather than accepted as a
     * boolean from the caller. §6's matrix is the single source of truth for who may
     * override — `update FraudOverride`, org_admin only — and a `canOverride: true`
     * parameter would let any caller assert its way past it. `defineAbilityFor` is the
     * same function the route guard uses, so the two cannot disagree.
     */
    if (!defineAbilityFor(input.actor).can('update', 'FraudOverride')) {
      throw new FraudError(
        'FRAUD_OVERRIDE_UNAUTHORISED',
        'Only an org admin can confirm an order the fraud rules blocked.',
      );
    }

    if (reason.length < 10) {
      throw new FraudError(
        'FRAUD_OVERRIDE_REASON_REQUIRED',
        'An override needs a reason of at least 10 characters — it is what the audit log records.',
      );
    }

    const overrideId = await repo.insertOverride(tx, {
      orgId: input.orgId,
      orderId: input.orderId,
      phoneHash: this.hasher.hash(input.phone),
      trustScore: badge.trustScore,
      reason,
      decidedBy: input.actor.userId,
    });

    /*
     * The audit row, in the same transaction (check 5). Both this and
     * `fraud.overrides` hold the fact, and that is not redundancy: the audit log is
     * where a reviewer looks for "who did what" across the whole system, and the
     * overrides table is what the order desk and the fraud report read without needing
     * `read AuditLog`.
     *
     * `after` carries the score, the decision and the reason — and no phone number and
     * no hash. `AuditService.record` redacts what it is given, but the right amount of
     * personal data in an append-only table is none.
     */
    await this.audit.record(tx, {
      orgId: input.orgId,
      actorUserId: input.actor.userId,
      operation: 'approve',
      action: 'fraud.override_granted',
      entityType: 'fraud.override',
      entityId: overrideId,
      after: {
        orderId: input.orderId,
        trustScore: badge.trustScore,
        decision: badge.decision,
        reason,
        reasonCodes: badge.reasons.map((entry) => entry.code),
      },
      ...(input.request === undefined ? {} : { request: input.request }),
    });

    return { ...badge, overridden: true, overrideId };
  }

  /**
   * Raise a manual flag against a number (§10's "manual flags").
   *
   * Two writes, and the split is the whole cross-org design: the *reason* and the
   * *author* go in `fraud.phone_flags`, which is tenant-scoped, and only `{at,
   * severity}` goes in the cross-org array. The other four brands learn that somebody
   * flagged this number, which is what the score needs; they do not learn who, or why,
   * or from which brand.
   *
   * `update FraudOverride` is the ability, which is org_admin only. §6's matrix has no
   * cell for raising a flag, and the nearest one it does have is the fraud override —
   * both are an org_admin making a standing decision about a buyer that changes whether
   * the brand will sell to them. Recorded as a decision row rather than invented here.
   */
  async raiseFlag(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly phone: string;
      readonly severity: number;
      readonly reason: string;
      readonly actorUserId: string;
      readonly request?: AuditableRequest;
    },
  ): Promise<{ readonly id: string }> {
    const phoneHash = this.hasher.hash(input.phone);
    const at = new Date();

    const id = await repo.insertFlag(tx, {
      orgId: input.orgId,
      phoneHash,
      severity: input.severity,
      reason: input.reason,
      createdBy: input.actorUserId,
    });

    await repo.adjustManualFlags(tx, {
      phoneHash,
      direction: 'add',
      severity: input.severity,
      at,
    });

    await this.audit.record(tx, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      operation: 'create',
      action: 'fraud.flag_raised',
      entityType: 'fraud.phone_flag',
      entityId: id,
      // No phone number and no hash: see the note in `assertConfirmAllowed`.
      after: { severity: input.severity, reason: input.reason },
      ...(input.request === undefined ? {} : { request: input.request }),
    });

    return { id };
  }

  /** Clear a standing flag, with a reason. The cross-org entry goes with it. */
  async clearFlag(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly flagId: string;
      readonly reason: string;
      readonly actorUserId: string;
      readonly request?: AuditableRequest;
    },
  ): Promise<void> {
    const cleared = await repo.clearFlag(tx, {
      orgId: input.orgId,
      flagId: input.flagId,
      clearedBy: input.actorUserId,
      reason: input.reason,
    });

    if (cleared === null) {
      // Out of scope and already cleared answer the same way as nonexistent: a
      // distinguishable "that flag belongs to another brand" is an existence oracle for
      // a table keyed by a phone number.
      throw new FraudError('FRAUD_FLAG_NOT_FOUND', 'No such standing flag in this brand.');
    }

    await repo.adjustManualFlags(tx, {
      phoneHash: cleared.phoneHash,
      direction: 'remove',
      severity: cleared.severity,
      at: new Date(),
    });

    await this.audit.record(tx, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      operation: 'update',
      action: 'fraud.flag_cleared',
      entityType: 'fraud.phone_flag',
      entityId: input.flagId,
      after: { clearedReason: input.reason },
      ...(input.request === undefined ? {} : { request: input.request }),
    });
  }

  /**
   * The overrides recorded against one order.
   *
   * Read through the org's own RLS, so an order id guessed from another brand returns an
   * empty list rather than a refusal — which is the answer that gives nothing away.
   */
  async overridesFor(tx: Tx, orgId: string, orderId: string): Promise<readonly repo.OverrideRow[]> {
    return repo.readOverrides(tx, orgId, orderId);
  }

  /** This brand's own flags on a number, reasons included — they never leave the org. */
  async flagsFor(
    tx: Tx,
    input: { readonly orgId: string; readonly phone: string },
  ): Promise<readonly repo.FlagRow[]> {
    return repo.readFlags(tx, input.orgId, this.hasher.hash(input.phone));
  }

  /** Write one org's bands. Validated in the domain, in the service and in 0047. */
  async setRules(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly rules: repo.OrgRulesRow;
      readonly actorUserId: string;
      readonly request?: AuditableRequest;
    },
  ): Promise<repo.OrgRulesRow> {
    assertBands(input.rules);
    const before = await repo.readRules(tx, input.orgId);
    const saved = await repo.upsertRules(tx, input.orgId, input.rules);

    await this.audit.record(tx, {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      operation: before === null ? 'create' : 'update',
      action: 'fraud.rules_changed',
      entityType: 'fraud.rules',
      entityId: input.orgId,
      before: before === null ? null : { ...before },
      after: { ...saved },
      ...(input.request === undefined ? {} : { request: input.request }),
    });

    return saved;
  }

  /**
   * Announce a verdict that is worth telling somebody about (`order.fraud_flagged`).
   *
   * Only for `warn`, `require_advance` and `block`. An `allow` is the overwhelming
   * majority of orders and an event for each one would be a live feed of nothing, at the
   * cost of an outbox row per confirm — §19's throttling note exists because this kind
   * of event is where a realtime layer drowns.
   *
   * Through the outbox, in the caller's transaction, like every other event (§19).
   */
  async announce(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly orderNo: string;
      readonly badge: FraudBadge;
    },
  ): Promise<boolean> {
    if (input.badge.decision === 'allow') return false;

    await emit(
      tx,
      'order.fraud_flagged',
      {
        id: input.orderId,
        orderNo: input.orderNo,
        trustScore: input.badge.trustScore,
        decision: input.badge.decision,
        reasons: input.badge.reasons.map((reason) => reason.code),
        providerAvailable: input.badge.providerAvailable,
        at: input.badge.assessedAt,
      },
      { orgId: input.orgId },
    );
    return true;
  }
}

/** What the badge's server side hands a UI (M13: "the badge and its reasons"). */
export interface FraudBadge {
  readonly trustScore: number;
  readonly decision: TrustAssessment['decision'];
  readonly reasons: readonly TrustReason[];
  readonly providerAvailable: boolean;
  readonly bands: FraudBands;
  /** Cross-org counts. Null for a number nobody has ever sold to. */
  readonly signals: {
    readonly ordersTotal: number;
    readonly delivered: number;
    readonly returned: number;
    readonly cancelled: number;
    readonly lastIncidentAt: string | null;
    readonly manualFlagCount: number;
  } | null;
  readonly providers: readonly {
    readonly name: string;
    readonly total: number;
    readonly delivered: number;
    readonly returnedOrCancelled: number;
    readonly fetchedAt: string;
  }[];
  readonly assessedAt: string;
}

export interface AssertConfirmAllowedInput {
  readonly orgId: string;
  readonly orderId: string;
  /** Any spelling `normalizeBdPhone` accepts. Hashed here; never stored or logged. */
  readonly phone: string;
  /**
   * Who is confirming.
   *
   * The whole ability context, not a `canOverride` boolean: §6's matrix decides who may
   * override, and a boolean parameter would let a caller assert its way past it.
   */
  readonly actor: AbilityContext;
  readonly overrideReason?: string | null;
  readonly request?: AuditableRequest;
}

export interface FraudGateDecision extends FraudBadge {
  readonly overridden: boolean;
  readonly overrideId: string | null;
}
