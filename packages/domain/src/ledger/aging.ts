import type { IsoDate } from '../dates/index.js';
import { add, sub, ZERO, type Poisha } from '../money/index.js';

/**
 * Payables and receivables aging, by open item (§7 "Reports", M08).
 *
 * What a party owes, or is owed, split by how long it has been outstanding. The
 * age belongs to the amount still open, not to every line that ever touched the
 * account: a ৳1,000 bill from forty days ago, part-paid ৳400 three days ago, is
 * ৳600 at 31–60 days. Bucketing each line by its own date instead says +৳1,000
 * at 31–60 and −৳400 at 0–7 — the same total, and a report nobody can act on,
 * because the negative bucket hides how old the debt really is.
 *
 * So settlements are matched first in, first out: a payment or credit settles
 * the oldest amount still open. Money paid ahead of anything owed — an advance
 * to a supplier, a customer's prepayment — is not aged; it is carried as
 * `unappliedPoisha` and taken up by the next amounts that fall due.
 *
 * The server reads one movement per party per business date from the ledger and
 * folds it here; this is the definition the report is tested against.
 */

export type LedgerAgingBucket = '0-7' | '8-30' | '31-60' | '60+';

export const LEDGER_AGING_BUCKETS: readonly LedgerAgingBucket[] = ['0-7', '8-30', '31-60', '60+'];

/** One day's movement on a party's balance, on the account's normal side. */
export interface PartyMovement {
  readonly businessDate: IsoDate;
  /** What became owed: a bill on a payable, a sale on a receivable. Never negative. */
  readonly increasePoisha: Poisha;
  /** What was settled: a payment, a return, a credit note. Never negative. */
  readonly decreasePoisha: Poisha;
}

export interface AgedBalance {
  /** The open amount in each age band. Never negative. */
  readonly buckets: Readonly<Record<LedgerAgingBucket, Poisha>>;
  /** Settled ahead of anything owed. Never negative, and never beside an open amount. */
  readonly unappliedPoisha: Poisha;
  /** Σ buckets − unapplied, which is Σ increases − Σ decreases up to the date. */
  readonly balancePoisha: Poisha;
}

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to`, both calendar dates. */
function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The band an amount falls in, by days since it became owed. Same edges as §7. */
export function ledgerAgingBucketOf(age: number): LedgerAgingBucket {
  if (age <= 7) return '0-7';
  if (age <= 30) return '8-30';
  if (age <= 60) return '31-60';
  return '60+';
}

export function ageOpenItems(movements: Iterable<PartyMovement>, asOf: IsoDate): AgedBalance {
  /*
   * A day is netted before it is matched, so a bill and its payment on the same
   * day settle each other rather than the payment reaching back to an older
   * bill — a COD sale created and collected in one day is not owed at all. It
   * also makes the answer independent of how the caller grouped the day's
   * lines: one row per account, per journal, or one for the day.
   */
  const netByDate = new Map<IsoDate, bigint>();
  for (const movement of movements) {
    if (movement.increasePoisha < 0n || movement.decreasePoisha < 0n) {
      throw new RangeError('An aging movement is an increase and a decrease, each never negative.');
    }
    if (movement.businessDate > asOf) continue;
    netByDate.set(
      movement.businessDate,
      (netByDate.get(movement.businessDate) ?? 0n) +
        movement.increasePoisha -
        movement.decreasePoisha,
    );
  }
  const days = [...netByDate.keys()].sort();

  /** Oldest first. Each entry is an amount still open and the date it became owed. */
  const open: { date: IsoDate; remaining: Poisha }[] = [];
  let unapplied = ZERO;

  for (const day of days) {
    const net = netByDate.get(day) ?? 0n;

    let increase = net > 0n ? (net as Poisha) : ZERO;
    if (increase > 0n && unapplied > 0n) {
      const taken = increase < unapplied ? increase : unapplied;
      increase = sub(increase, taken);
      unapplied = sub(unapplied, taken);
    }
    if (increase > 0n) open.push({ date: day, remaining: increase });

    let decrease = net < 0n ? (-net as Poisha) : ZERO;
    while (decrease > 0n && open.length > 0) {
      const oldest = open[0];
      if (oldest === undefined) break;
      if (oldest.remaining <= decrease) {
        decrease = sub(decrease, oldest.remaining);
        open.shift();
      } else {
        oldest.remaining = sub(oldest.remaining, decrease);
        decrease = ZERO;
      }
    }
    if (decrease > 0n) unapplied = add(unapplied, decrease);
  }

  const buckets: Record<LedgerAgingBucket, Poisha> = {
    '0-7': ZERO,
    '8-30': ZERO,
    '31-60': ZERO,
    '60+': ZERO,
  };
  let openTotal = ZERO;
  for (const item of open) {
    const bucket = ledgerAgingBucketOf(daysBetween(item.date, asOf));
    buckets[bucket] = add(buckets[bucket], item.remaining);
    openTotal = add(openTotal, item.remaining);
  }

  return { buckets, unappliedPoisha: unapplied, balancePoisha: sub(openTotal, unapplied) };
}
