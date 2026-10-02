import { Inject, Injectable, Logger } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import {
  addDays,
  businessDate,
  maskPhone,
  poisha,
  takaParts,
  toIsoDate,
  type IsoDate,
} from '@elysium/domain';
import { isReminderDue, MAX_REMINDER_DAYS } from '@elysium/domain/loans';
import { sql } from 'drizzle-orm';

import { emit } from '../../platform/events/outbox.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { pgCode } from './loans.errors.js';
import { LOANS_QUEUES } from './loans.queues.js';
import * as repo from './loans.repository.js';
import { LOANS_NOTIFY_PORT, type LoansNotifyPort } from './ports/notify.port.js';

/**
 * Loan reminders: N days before each due date, in-app and by SMS, exactly once per
 * instalment (architecture §15, §20; M26 check 3).
 *
 * ## How "once" is kept
 *
 * Each reminder is one transaction: the SMS is queued (a `notify.messages` row and its
 * `notify.send` job), the in-app event is written to the outbox, and the reminder row is
 * inserted last. That row is unique per instalment and immutable (0090). So:
 *
 * - a second run the same day finds the row and skips (the fast path);
 * - two runs racing each other both pass the fast path, and the loser's insert fails on
 *   the unique index — rolling back *its* message and *its* event with it, because they
 *   were written in the same transaction. Nothing is left behind.
 *
 * No external call happens here (invariant 6): the gateway is called by `notify.send`
 * after this transaction commits, and the realtime event is delivered by the outbox
 * dispatcher after commit too.
 *
 * ## What goes out (D-300)
 *
 * The in-app reminder always: `loan.instalment_due` to accounts and org_admin, which the
 * console's notification inbox shows. The SMS only when the loan names a reminder phone
 * (the brand's own staff number), through the brand's `loan.instalment_due` template.
 * A missing template or phone does not stop the in-app reminder; the reminder row records
 * what happened to the SMS.
 */

export const LOAN_REMINDER_TEMPLATE = 'loan.instalment_due';

const ACTOR = 'system:loans';

export interface ReminderRun {
  readonly due: number;
  readonly reminded: number;
  readonly alreadyReminded: number;
  readonly failed: readonly { readonly instalmentId: string; readonly reason: string }[];
}

/** `3400.22`: the instalment in taka for the SMS, through the money module's own split. */
function taka(value: bigint): string {
  const parts = takaParts(poisha(value));
  return `${parts.taka.toString()}.${parts.poisha.toString().padStart(2, '0')}`;
}

@Injectable()
export class LoanRemindersService {
  private readonly logger = new Logger(LoanRemindersService.name);

  constructor(@Inject(LOANS_NOTIFY_PORT) private readonly notify: LoansNotifyPort) {}

  /**
   * Remind for every unpaid instalment of one brand whose reminder date has arrived.
   *
   * `today` is the Asia/Dhaka business date the job was scheduled for and `now` the
   * instant the messages are due; both are parameters so a test can run a fixed day twice.
   */
  async run(orgId: string, today: IsoDate, now: Date = new Date()): Promise<ReminderRun> {
    const actor = { orgId, userId: ACTOR };
    const candidates = await withOrg(actor, (tx) =>
      repo.reminderCandidates(tx, orgId, addDays(today, MAX_REMINDER_DAYS)),
    );
    const due = candidates.filter((row) =>
      isReminderDue(toIsoDate(row.due_on), row.reminder_days, today),
    );

    let reminded = 0;
    let alreadyReminded = 0;
    const failed: { instalmentId: string; reason: string }[] = [];

    for (const row of due) {
      try {
        const outcome = await withOrg(actor, async (tx) => {
          if (await repo.reminderExists(tx, orgId, row.instalment_id)) return 'already' as const;

          let smsState: 'queued' | 'suppressed' | 'no_phone' | 'failed' = 'no_phone';
          let messageId: string | null = null;
          if (row.reminder_phone !== null) {
            try {
              // A savepoint, so a missing template or a refused number undoes only the
              // SMS and the in-app reminder still goes.
              const queued = await tx.transaction((savepoint) =>
                this.notify.queue(savepoint, orgId, {
                  templateKey: LOAN_REMINDER_TEMPLATE,
                  phone: row.reminder_phone ?? '',
                  locale: 'bn',
                  values: {
                    lender: row.lender_name,
                    seq: String(row.seq),
                    due: row.due_on,
                    amount: taka(BigInt(row.total_poisha)),
                  },
                  refType: 'loan_instalment',
                  refId: row.instalment_id,
                  category: 'transactional',
                  now,
                }),
              );
              smsState = queued.state;
              messageId = queued.messageId;
            } catch (error) {
              smsState = 'failed';
              const reason = error instanceof Error ? error.message : String(error);
              // The instalment and a masked phone; never the number (invariant 10).
              this.logger.warn(
                `loan reminder SMS for ${row.instalment_id} (${maskPhone(row.reminder_phone)}) not queued: ${reason}`,
              );
            }
          }

          await emit(
            tx,
            'loan.instalment_due',
            {
              loanId: row.loan_id,
              instalmentId: row.instalment_id,
              seq: row.seq,
              dueOn: row.due_on,
              amountPoisha: row.total_poisha,
            },
            { orgId },
          );
          await repo.insertReminder(tx, {
            orgId,
            loanId: row.loan_id,
            instalmentId: row.instalment_id,
            remindedOn: today,
            smsState,
            messageId,
          });
          return 'reminded' as const;
        });
        if (outcome === 'reminded') reminded += 1;
        else alreadyReminded += 1;
      } catch (error) {
        // A racing run's insert lost on the unique index: its transaction — message, event
        // and all — rolled back, and the instalment *was* reminded, by the other run.
        if (pgCode(error) === '23505') {
          alreadyReminded += 1;
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        failed.push({ instalmentId: row.instalment_id, reason });
        this.logger.warn(`loan reminder for ${row.instalment_id} failed: ${reason}`);
      }
    }

    if (failed.length > 0) {
      // Thrown after the others went, so the job retries only what failed.
      throw new Error(`${String(failed.length)} loan reminder(s) failed in org ${orgId}`);
    }
    return { due: due.length, reminded, alreadyReminded, failed };
  }

  /**
   * The scheduled half: enumerate the active brands and enqueue one run each, carrying
   * today's Dhaka date so a retry after midnight reminds for the day it was meant to.
   */
  async fanOut(now: Date = new Date()): Promise<number> {
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
          LOANS_QUEUES.reminders,
          { today },
          // One per brand per day: a fan-out that runs twice enqueues nothing new.
          { orgId, singletonKey: `reminders:${orgId}:${today}` },
        ),
      );
    }
    return orgIds.length;
  }
}
