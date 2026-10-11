import { Inject, Injectable, Logger } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import { addDays, businessDate, maskPhone, poisha, toIsoDate, type IsoDate } from '@elysium/domain';
import { dueOccasions, rfm, type BuyerActivity } from '@elysium/domain/crm';

import { sql } from 'drizzle-orm';

import { enqueue } from '../../platform/jobs/enqueue.js';
import { CRM_QUEUES } from './crm.queues.js';
import * as repo from './crm.repository.js';
import { NOTIFY_PORT, type NotifyPort } from './ports/notify.port.js';
import { PROMO_PORT, type PromoPort } from './ports/promo.port.js';

/**
 * Who a brand's buyers are, and the greetings it owes them (M16; §10).
 *
 * Two jobs live here, each run per org:
 *
 * - **`runRfm`** recomputes every buyer's recency, frequency and monetary scores and their
 *   segment, nightly. Quintiles are *within the org* (the domain's rule), so a brand's
 *   champions are its own best buyers, not the group's.
 * - **`runOccasions`** greets buyers whose birthday or anniversary falls on today in Dhaka
 *   with a personal single-use code and a message. Check 2 is that this is idempotent:
 *   one code and one message per buyer per occasion per year, however often it runs.
 *
 * ## How check 2 is kept
 *
 * Each greeting is one transaction: the code, then the message, then the row recording
 * that the greeting went out. That row has a unique index on
 * `(org, customer, occasion, year)` and is immutable once written (0079). So:
 *
 * - a second run the same day finds the row and skips (the fast path);
 * - two runs racing each other both get past the fast path, and the second one's insert
 *   fails on the unique index — which rolls back *its* code and *its* message with it,
 *   because they were written in the same transaction. Nothing is left behind.
 *
 * The code and the message are written before the row, not after, because the row is
 * immutable and has to carry their ids from the start.
 */

/** What every occasion code is worth until a brand can set its own (D-206, ASSUMED). */
export const OCCASION_CODE = {
  kind: 'percent' as const,
  valueBps: 1_000, // 10% off
  validDays: 7,
};

export const OCCASION_TEMPLATES = {
  birthday: 'occasion.birthday',
  anniversary: 'occasion.anniversary',
} as const;

const ACTOR = 'system:crm';

export interface OccasionRun {
  readonly due: number;
  readonly greeted: number;
  readonly alreadyGreeted: number;
  /** Buyers who could not be greeted, with why — never their phone. */
  readonly failed: readonly { readonly customerId: string; readonly reason: string }[];
}

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    @Inject(PROMO_PORT) private readonly promo: PromoPort,
    @Inject(NOTIFY_PORT) private readonly notify: NotifyPort,
  ) {}

  /**
   * Greet today's birthdays and anniversaries in one brand.
   *
   * `today` is the Asia/Dhaka business date and `now` the instant the messages are due;
   * both are parameters so a test can run the job for a fixed day and run it twice.
   */
  async runOccasions(orgId: string, today: IsoDate, now: Date = new Date()): Promise<OccasionRun> {
    const actor = { orgId, userId: ACTOR };
    const buyers = await withOrg(actor, (tx) => repo.buyersWithOccasions(tx, orgId));
    const byId = new Map(buyers.map((buyer) => [buyer.id, buyer]));
    const due = dueOccasions(
      buyers.map((buyer) => ({
        customerId: buyer.id,
        birthday: buyer.birthday,
        anniversary: buyer.anniversary,
      })),
      today,
    );

    let greeted = 0;
    let alreadyGreeted = 0;
    const failed: { customerId: string; reason: string }[] = [];

    for (const occasion of due) {
      const buyer = byId.get(occasion.customerId);
      if (buyer === undefined) continue;

      try {
        const outcome = await withOrg(actor, async (tx) => {
          // The fast path: greeted already this year, so nothing to write.
          if (await repo.occasionIssued(tx, orgId, buyer.id, occasion.occasion, occasion.year)) {
            return 'already' as const;
          }

          const { codeId, code } = await this.promo.issueOccasionCode(tx, orgId, {
            customerId: buyer.id,
            occasion: occasion.occasion,
            kind: OCCASION_CODE.kind,
            valueBps: OCCASION_CODE.valueBps,
            valuePoisha: 0n,
            validFrom: today,
            validTo: addDays(today, OCCASION_CODE.validDays - 1),
            actorUserId: ACTOR,
          });
          const { messageId } = await this.notify.queue(tx, orgId, {
            templateKey: OCCASION_TEMPLATES[occasion.occasion],
            phone: buyer.phone_e164,
            values: { name: buyer.name, code },
            refType: 'occasion',
            refId: codeId,
            // An offer, so opt-outs and quiet hours apply — whatever the template says.
            category: 'marketing',
            now,
          });
          await repo.insertOccasionIssue(tx, {
            orgId,
            customerId: buyer.id,
            occasion: occasion.occasion,
            year: occasion.year,
            promoCodeId: codeId,
            messageId,
          });
          return 'greeted' as const;
        });
        if (outcome === 'greeted') greeted += 1;
        else alreadyGreeted += 1;
      } catch (error) {
        // A racing run's insert lost on the unique index: its transaction — code, message
        // and all — rolled back, and the buyer *was* greeted, by the other run.
        if (isUniqueViolation(error)) {
          alreadyGreeted += 1;
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        failed.push({ customerId: buyer.id, reason });
        // The buyer's id and a masked phone; never the number (invariant 10).
        this.logger.warn(
          `occasion greeting for ${buyer.id} (${maskPhone(buyer.phone_e164)}) failed: ${reason}`,
        );
      }
    }

    return { due: due.length, greeted, alreadyGreeted, failed };
  }

  /**
   * The scheduled half of each job: enumerate the active brands and enqueue one job each.
   *
   * Carries today's Dhaka date in every payload, so a per-brand job retried after midnight
   * still works on the day it was scheduled for. Returns how many were enqueued.
   */
  async fanOut(kind: 'occasions' | 'rfm', now: Date = new Date()): Promise<number> {
    const today = businessDate(now);
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.organizations where is_active order by slug
      `);
      return [...rows].map((row) => row.id);
    });
    for (const orgId of orgIds) {
      await withOrg({ orgId, userId: ACTOR }, (tx) =>
        enqueue(
          tx,
          kind === 'occasions' ? CRM_QUEUES.occasions : CRM_QUEUES.rfm,
          { today },
          {
            orgId,
            // One per brand per day: a fan-out that runs twice enqueues nothing new.
            singletonKey: `${kind}:${orgId}:${today}`,
          },
        ),
      );
    }
    return orgIds.length;
  }

  /** Recompute every buyer's segment in one brand. Replaces, never accumulates. */
  async runRfm(orgId: string, today: IsoDate): Promise<{ readonly scored: number }> {
    const actor = { orgId, userId: ACTOR };
    return withOrg(actor, async (tx) => {
      const rows = await repo.buyerActivity(tx, orgId);
      const activity: BuyerActivity[] = rows.map((row) => ({
        customerId: row.id,
        lastOrderOn: row.last_delivered_on === null ? null : toIsoDate(row.last_delivered_on),
        orders: row.delivered_count,
        spentPoisha: poisha(row.ltv_poisha),
      }));
      const scores = rfm(activity, today);
      for (const [customerId, score] of scores) {
        await repo.upsertSegment(tx, {
          orgId,
          customerId,
          recency: score.recency,
          frequency: score.frequency,
          monetary: score.monetary,
          segment: score.segment,
          computedOn: today,
        });
      }
      return { scored: scores.size };
    });
  }
}

/** Postgres `unique_violation`, however the driver wraps it. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
