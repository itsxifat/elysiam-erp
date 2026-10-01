import { daysBetween, type IsoDate } from '../dates/index.js';

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

/**
 * One day's movement on a party's balance, on the account's normal side.
 *
 * Plain `bigint` rather than `Poisha`, like every report aggregate (M03 review M2):
 * these are sums of posted lines, already inside the ledger, and a report must
 * never throw on a sum the ledger holds.
 */
export interface PartyMovement {
  readonly businessDate: IsoDate;
  /** What became owed: a bill on a payable, a sale on a receivable. Never negative. */
  readonly increasePoisha: bigint;
  /** What was settled: a payment, a return, a credit note. Never negative. */
  readonly decreasePoisha: bigint;
}

export interface AgedBalance {
  /** The open amount in each age band. Never negative. */
  readonly buckets: Readonly<Record<LedgerAgingBucket, bigint>>;
  /** Settled ahead of anything owed. Never negative, and never beside an open amount. */
  readonly unappliedPoisha: bigint;
  /** Σ buckets − unapplied, which is Σ increases − Σ decreases up to the date. */
  readonly balancePoisha: bigint;
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

  /**
   * Oldest first. Each entry is an amount still open and the date it became owed;
   * entries before `head` are fully settled. An index rather than `shift()`, so a
   * party with years of daily movements is matched in one pass.
   */
  const open: { date: IsoDate; remaining: bigint }[] = [];
  let head = 0;
  let unapplied = 0n;

  for (const day of days) {
    const net = netByDate.get(day) ?? 0n;

    if (net > 0n) {
      const taken = net < unapplied ? net : unapplied;
      unapplied -= taken;
      if (net > taken) open.push({ date: day, remaining: net - taken });
      continue;
    }

    let decrease = -net;
    while (decrease > 0n && head < open.length) {
      const oldest = open[head];
      if (oldest === undefined) break;
      if (oldest.remaining <= decrease) {
        decrease -= oldest.remaining;
        head += 1;
      } else {
        oldest.remaining -= decrease;
        decrease = 0n;
      }
    }
    unapplied += decrease;
  }

  const buckets: Record<LedgerAgingBucket, bigint> = {
    '0-7': 0n,
    '8-30': 0n,
    '31-60': 0n,
    '60+': 0n,
  };
  let openTotal = 0n;
  for (const item of open.slice(head)) {
    const bucket = ledgerAgingBucketOf(daysBetween(item.date, asOf));
    buckets[bucket] += item.remaining;
    openTotal += item.remaining;
  }

  return { buckets, unappliedPoisha: unapplied, balancePoisha: openTotal - unapplied };
}
