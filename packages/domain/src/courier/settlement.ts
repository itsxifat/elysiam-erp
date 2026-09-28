import { addDays, periodOf, type IsoDate } from '../dates/index.js';
import { add, sub, sum, ZERO, type Poisha } from '../money/index.js';

/**
 * Matching a courier's settlement statement against our own receivable
 * (architecture §7 "COD settlement received", §9 "Settlement import", D-037).
 *
 * Every number a settlement posts is computed here, as a pure function of the file's
 * rows and the consignments we think the courier is holding money for. It is in the
 * domain for invariant 11's reason and for one more: a settlement is the moment the
 * courier's arithmetic and ours are compared, and a comparison whose logic lives
 * inside a service that also writes rows is a comparison nobody can test exhaustively.
 *
 * ## What "matched" has to mean
 *
 * Acceptance check 4 wants "matched totals equal the file totals and lists every
 * mismatch". Those two clauses pull in opposite directions unless matching is strict:
 * a lenient matcher that accepted a row whose COD differed by ৳50 would make the
 * totals agree and report no mismatch, and the ৳50 would land in the ledger as a
 * courier charge nobody agreed to. So a row matches only when the consignment is
 * found, is not already settled, the file's own net agrees with its gross minus its
 * charges, and the COD the courier says it collected equals the receivable we
 * recorded on delivery. Anything else is an exception, is excluded from the posting,
 * and is listed.
 *
 * Excluded, not adjusted. The tempting alternative — post what the courier says and
 * let the difference fall into the receivable — is how a courier balance acquires a
 * residue that grows every month and that nobody can attribute to a parcel.
 */

/** One row of a courier's statement, already parsed out of its file. */
export interface SettlementFileRow {
  /** The courier's own id for the parcel. The primary match key. */
  readonly consignmentNo: string;
  /** Our reference as the courier echoes it back — an order number. Secondary key. */
  readonly reference: string | null;
  /** What the courier says it collected at the door. */
  readonly codCollectedPoisha: Poisha;
  /** The delivery fee the courier kept. */
  readonly deliveryChargePoisha: Poisha;
  /** The return fee, on a parcel that came back. */
  readonly returnChargePoisha: Poisha;
  /** COD fee, fuel surcharge, whatever else the statement itemises. */
  readonly otherChargePoisha: Poisha;
  /**
   * The net the courier says it is paying us, when the file states one.
   *
   * Kept separate from `gross − charges` rather than derived, precisely so the two
   * can be compared: a statement whose own columns disagree is the single most
   * common real defect in a courier file, and it has to be found before it is posted
   * rather than after.
   */
  readonly netPoisha: Poisha | null;
  /** 1-based, for an exceptions report a person has to reconcile against a sheet. */
  readonly rowNo: number;
}

/** A consignment we believe this courier owes us for. */
export interface SettlementCandidate {
  readonly consignmentId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly consignmentNo: string;
  /** What delivery debited courier receivable with, for this consignment. */
  readonly receivablePoisha: Poisha;
  /** True when an earlier settlement already covered it. */
  readonly settled: boolean;
}

export type SettlementMatch =
  'matched' | 'unmatched' | 'amount_mismatch' | 'duplicate' | 'already_settled';

export interface MatchedLine {
  readonly rowNo: number;
  readonly consignmentNo: string;
  readonly reference: string | null;
  readonly match: SettlementMatch;
  /** Null unless the row matched a consignment we hold. */
  readonly consignmentId: string | null;
  readonly orderId: string | null;
  readonly codCollectedPoisha: Poisha;
  readonly deliveryChargePoisha: Poisha;
  readonly returnChargePoisha: Poisha;
  readonly otherChargePoisha: Poisha;
  /** Gross minus every charge. Computed, never taken from the file. */
  readonly netPoisha: Poisha;
  /** What our books say the courier owes for this consignment, when we found it. */
  readonly expectedPoisha: Poisha | null;
  /** Why it is an exception, in words an accountant can act on. Null when matched. */
  readonly note: string | null;
}

export interface SettlementTotals {
  /** Every row in the file, matched or not. */
  readonly fileGrossPoisha: Poisha;
  readonly fileChargesPoisha: Poisha;
  readonly fileNetPoisha: Poisha;
  readonly fileRowCount: number;
  /** The matched subset — the only rows that will post. */
  readonly matchedGrossPoisha: Poisha;
  readonly matchedChargesPoisha: Poisha;
  readonly matchedDeliveryChargesPoisha: Poisha;
  readonly matchedReturnChargesPoisha: Poisha;
  readonly matchedOtherChargesPoisha: Poisha;
  readonly matchedNetPoisha: Poisha;
  readonly matchedRowCount: number;
  readonly exceptionCount: number;
}

export interface SettlementMatchResult {
  readonly lines: readonly MatchedLine[];
  readonly totals: SettlementTotals;
  /** The subset of `lines` a person has to deal with. §9's exceptions report. */
  readonly exceptions: readonly MatchedLine[];
}

function normaliseKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Match a parsed statement against our consignments.
 *
 * Matching is by the courier's consignment number first and by our own reference
 * second. Both, because couriers differ: some statements carry only their own id,
 * some only the invoice number we sent them, and one that carries both has been
 * known to carry a stale copy of one of them. Trying the courier's id first is
 * deliberate — it is the key the courier itself keys on, so it is the one that is
 * right when the two disagree.
 */
export function matchSettlement(
  rows: readonly SettlementFileRow[],
  candidates: readonly SettlementCandidate[],
): SettlementMatchResult {
  /*
   * Two indexes, and both refuse an ambiguous key rather than keeping the last writer.
   *
   * §9 allows an order to be rebooked with a second courier after a refusal, so two
   * consignments legitimately share one order number — and a consignment has no courier number
   * at all until its booking succeeds, so several can share the empty string. A plain
   * `map.set()` made both cases silently last-one-wins, ordered by whatever the candidate query
   * returned: a statement row carrying no consignment number would then settle whichever of the
   * two the map happened to keep. Usually the amounts differ and it lands as an exception, but
   * where both are zero — two returns — the wrong consignment is marked settled and the right
   * one never is.
   *
   * So a key that maps to more than one candidate is *removed*, and a row matching it becomes
   * `unmatched` with a note. An exception a person reads is the correct outcome for a genuine
   * ambiguity; a coin toss is not.
   */
  const byConsignment = new Map<string, SettlementCandidate>();
  const byReference = new Map<string, SettlementCandidate>();
  const ambiguousConsignment = new Set<string>();
  const ambiguousReference = new Set<string>();

  for (const candidate of candidates) {
    // An unbooked consignment has no courier number. Indexing it under '' would collapse every
    // such parcel onto one key.
    const consignmentKey = normaliseKey(candidate.consignmentNo);
    if (consignmentKey !== '') {
      if (byConsignment.has(consignmentKey)) ambiguousConsignment.add(consignmentKey);
      byConsignment.set(consignmentKey, candidate);
    }

    const referenceKey = normaliseKey(candidate.orderNo);
    if (referenceKey !== '') {
      if (byReference.has(referenceKey)) ambiguousReference.add(referenceKey);
      byReference.set(referenceKey, candidate);
    }
  }
  for (const key of ambiguousConsignment) byConsignment.delete(key);
  for (const key of ambiguousReference) byReference.delete(key);

  /*
   * Consignments already claimed by an earlier row of *this* file.
   *
   * A statement listing one parcel twice is not hypothetical — a courier re-issuing a
   * corrected sheet by appending rather than replacing produces exactly that — and
   * posting both rows would credit the receivable twice and hand us cash we never
   * received. The first occurrence matches; the rest are `duplicate`.
   */
  const claimed = new Set<string>();

  const lines: MatchedLine[] = rows.map((row) => {
    const charges = sum([row.deliveryChargePoisha, row.returnChargePoisha, row.otherChargePoisha]);
    const net = sub(row.codCollectedPoisha, charges);
    const base = {
      rowNo: row.rowNo,
      consignmentNo: row.consignmentNo,
      reference: row.reference,
      codCollectedPoisha: row.codCollectedPoisha,
      deliveryChargePoisha: row.deliveryChargePoisha,
      returnChargePoisha: row.returnChargePoisha,
      otherChargePoisha: row.otherChargePoisha,
      netPoisha: net,
    } as const;

    const consignmentKey = normaliseKey(row.consignmentNo);
    const referenceKey = row.reference === null ? '' : normaliseKey(row.reference);
    const candidate =
      byConsignment.get(consignmentKey) ??
      (referenceKey === '' ? undefined : byReference.get(referenceKey));

    if (candidate === undefined) {
      const ambiguous =
        ambiguousConsignment.has(consignmentKey) || ambiguousReference.has(referenceKey);
      return {
        ...base,
        match: 'unmatched',
        consignmentId: null,
        orderId: null,
        expectedPoisha: null,
        // Two notes, because they call for opposite actions: "we have no such parcel" is a
        // question for the courier, and "this matches two of our parcels" is a rebooked order
        // somebody has to pick between.
        note: ambiguous
          ? 'More than one consignment of ours matches this row; the order was rebooked, so settle it by consignment number.'
          : 'No consignment of ours matches this row.',
      };
    }

    if (claimed.has(candidate.consignmentId)) {
      return {
        ...base,
        match: 'duplicate',
        consignmentId: candidate.consignmentId,
        orderId: candidate.orderId,
        expectedPoisha: candidate.receivablePoisha,
        note: 'This consignment appears more than once in the file.',
      };
    }

    if (candidate.settled) {
      return {
        ...base,
        match: 'already_settled',
        consignmentId: candidate.consignmentId,
        orderId: candidate.orderId,
        expectedPoisha: candidate.receivablePoisha,
        note: 'An earlier settlement already covered this consignment.',
      };
    }

    // The file disagreeing with itself. Checked before the comparison with our books,
    // because "your columns do not add up" is a different conversation with the
    // courier than "your collection does not match our order".
    if (row.netPoisha !== null && row.netPoisha !== net) {
      return {
        ...base,
        match: 'amount_mismatch',
        consignmentId: candidate.consignmentId,
        orderId: candidate.orderId,
        expectedPoisha: candidate.receivablePoisha,
        note: `The file's net (${row.netPoisha.toString()}) is not its gross minus its charges (${net.toString()}).`,
      };
    }

    if (row.codCollectedPoisha !== candidate.receivablePoisha) {
      return {
        ...base,
        match: 'amount_mismatch',
        consignmentId: candidate.consignmentId,
        orderId: candidate.orderId,
        expectedPoisha: candidate.receivablePoisha,
        note: `The courier reports collecting ${row.codCollectedPoisha.toString()} where our books expect ${candidate.receivablePoisha.toString()}.`,
      };
    }

    /*
     * A negative row net is legitimate and is *not* an exception.
     *
     * A parcel that came back collected nothing and still cost a return fee, so its
     * net is the fee, negative. §7's charges journal credits courier receivable with
     * it, which correctly says the courier no longer owes us that money — we owe them.
     * Refusing the row instead (the first version of this file did) would make every
     * return in a statement an exception a person had to clear by hand, monthly.
     *
     * What must not go negative is the *batch* net, because that is what debits a
     * wallet. `settlementOwesCourier` is where that is caught, once, with a total
     * somebody can act on rather than a row they cannot.
     */
    claimed.add(candidate.consignmentId);
    return {
      ...base,
      match: 'matched',
      consignmentId: candidate.consignmentId,
      orderId: candidate.orderId,
      expectedPoisha: candidate.receivablePoisha,
      note: null,
    };
  });

  const matched = lines.filter((line) => line.match === 'matched');
  const exceptions = lines.filter((line) => line.match !== 'matched');

  return {
    lines,
    totals: {
      fileGrossPoisha: sum(lines.map((line) => line.codCollectedPoisha)),
      fileChargesPoisha: sum(lines.map((line) => chargesOf(line))),
      fileNetPoisha: sum(lines.map((line) => line.netPoisha)),
      fileRowCount: lines.length,
      matchedGrossPoisha: sum(matched.map((line) => line.codCollectedPoisha)),
      matchedChargesPoisha: sum(matched.map((line) => chargesOf(line))),
      matchedDeliveryChargesPoisha: sum(matched.map((line) => line.deliveryChargePoisha)),
      matchedReturnChargesPoisha: sum(matched.map((line) => line.returnChargePoisha)),
      matchedOtherChargesPoisha: sum(matched.map((line) => line.otherChargePoisha)),
      matchedNetPoisha: sum(matched.map((line) => line.netPoisha)),
      matchedRowCount: matched.length,
      exceptionCount: exceptions.length,
    },
    exceptions,
  };
}

function chargesOf(line: MatchedLine): Poisha {
  return sum([line.deliveryChargePoisha, line.returnChargePoisha, line.otherChargePoisha]);
}

/**
 * Whether the matched rows will produce a balanced pair of journals at all.
 *
 * §7 splits a settlement into two journals — charges against the receivable, and the
 * net into a wallet — and each has to balance on its own. Charges of zero and a net
 * of zero are both legitimate on their own (a statement of pure returns has no net;
 * a courier that charges nothing has no charges), but a settlement where *both* are
 * zero posts nothing, and letting one through would leave a settlement marked posted
 * with no journal behind it.
 */
export function settlementPostsAnything(totals: SettlementTotals): boolean {
  return totals.matchedChargesPoisha > 0n || totals.matchedNetPoisha > 0n;
}

/**
 * True when the matched rows add up to us owing the courier money.
 *
 * It happens: a statement covering a week of nothing but returns has fees and no
 * collections. §7 has no journal for it — "Dr W" with a negative amount is not a
 * journal — and the courier's own practice is to carry the balance into the next
 * statement, so the honest thing is to refuse the import and say why rather than to
 * invent a payable the courier does not agree exists.
 *
 * Checked on the batch and not on the row, because a single return inside an
 * otherwise normal week is completely ordinary and must not need a person.
 */
export function settlementOwesCourier(totals: SettlementTotals): boolean {
  return totals.matchedNetPoisha < 0n;
}

/**
 * The gross the matched rows account for: charges + net.
 *
 * This is the figure credited to courier receivable across the two journals, and it has to
 * equal Σ what delivery debited for those consignments — otherwise the consignments' receivable
 * does not reach zero (acceptance check 5).
 *
 * The posting rule states the same identity from the other side
 * (`settlementRelievesPoisha`, over the four amounts rather than over the totals). Two
 * spellings of one invariant is one too many, so this one is defined in terms of that one: they
 * cannot drift because there is only one sum.
 */
export function matchedReceivableRelieved(totals: SettlementTotals): Poisha {
  return add(totals.matchedChargesPoisha, totals.matchedNetPoisha);
}

export interface SettlementPostingDate {
  /** The date the journals will carry. */
  readonly postingDate: IsoDate;
  /** The courier's own date, which stays on the row whatever happens (D-037). */
  readonly settlementDate: IsoDate;
  /** True when the settlement's own month was closed and it moved forward. */
  readonly deferred: boolean;
}

/**
 * Where a settlement posts when its own month is already closed (D-037).
 *
 * D-037: "A settlement posts on its own business date. If that period is closed it
 * posts to the earliest open period and keeps the original settlement date as a
 * reference field. Never silently back-dated."
 *
 * The rule exists because courier statements arrive after month-end close, every
 * month, without exception. The alternatives are both worse: reopening a closed
 * month needs a super-admin approval (§7) and would be a monthly ritual, and
 * refusing the import leaves cash in the courier's hands unrecorded.
 *
 * `closedMonthStarts` is every closed month's first day. D-093 says a closed month
 * locks every date before it as well, so the earliest open date is the day after the
 * **latest** closed month ends — not the first gap in the list. Computing it from the
 * first gap is the subtle wrong answer: close January and March, and a February
 * settlement would find February "open" and post into a month sandwiched between two
 * closed ones, which no trial balance can ever be re-run.
 *
 * The original date is returned rather than discarded, and the caller stores it on
 * the row. That is the half of D-037 that is easy to lose: overwrite it with the
 * posting date and the settlement no longer says which month's cash it was.
 */
export function resolveSettlementPostingDate(
  settlementDate: IsoDate,
  closedMonthStarts: readonly IsoDate[],
): SettlementPostingDate {
  if (closedMonthStarts.length === 0) {
    return { postingDate: settlementDate, settlementDate, deferred: false };
  }

  const latestClosedStart = [...closedMonthStarts].sort().at(-1);
  if (latestClosedStart === undefined) {
    return { postingDate: settlementDate, settlementDate, deferred: false };
  }

  const latestClosed = periodOf(latestClosedStart);
  if (settlementDate > latestClosed.endsOn) {
    return { postingDate: settlementDate, settlementDate, deferred: false };
  }

  return { postingDate: addDays(latestClosed.endsOn, 1), settlementDate, deferred: true };
}

/**
 * Courier receivable aging (§7's "receivable and payable aging" report).
 *
 * The buckets are §7's: 0–7, 8–30, 31–60, 60+ days. Age is measured from the
 * delivery date, because that is the day the courier started holding our money — not
 * from the booking date, which would age parcels still in transit and make the
 * report read as if a courier were late on cash it has not collected yet.
 */
export const AGING_BUCKETS = ['0_7', '8_30', '31_60', '60_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucketFor(asOf: IsoDate, since: IsoDate): AgingBucket {
  const days = daysBetween(since, asOf);
  if (days <= 7) return '0_7';
  if (days <= 30) return '8_30';
  if (days <= 60) return '31_60';
  return '60_plus';
}

export interface AgingItem {
  readonly since: IsoDate;
  readonly amountPoisha: Poisha;
}

export type AgingSummary = Readonly<Record<AgingBucket, Poisha>> & { readonly totalPoisha: Poisha };

export function summariseAging(asOf: IsoDate, items: readonly AgingItem[]): AgingSummary {
  const totals: Record<AgingBucket, Poisha> = {
    '0_7': ZERO,
    '8_30': ZERO,
    '31_60': ZERO,
    '60_plus': ZERO,
  };
  for (const item of items) {
    const bucket = agingBucketFor(asOf, item.since);
    totals[bucket] = add(totals[bucket], item.amountPoisha);
  }
  return {
    ...totals,
    totalPoisha: sum(items.map((item) => item.amountPoisha)),
  };
}

/**
 * Whole days between two business dates.
 *
 * Both are Asia/Dhaka calendar dates (invariant 8), so this is calendar arithmetic
 * and not a duration: parsing them as UTC midnights and subtracting gives the right
 * answer for exactly that reason, and using `Date.now()` anywhere in an aging report
 * would make the report's own numbers depend on when it was run.
 */
function daysBetween(from: IsoDate, to: IsoDate): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000);
}
