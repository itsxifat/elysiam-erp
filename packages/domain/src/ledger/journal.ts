import { isIsoDate, type IsoDate } from '../dates/index.js';
import { add, ZERO, type Poisha } from '../money/index.js';
import { PARTY_TYPES, type PartyType } from './accounts.js';

/**
 * Journal drafts (architecture §7 "Journal model").
 *
 * A posting rule — one pure function per business event, in
 * `packages/domain/src/posting` — turns an event into a `JournalDraft`.
 * `ledger.post(tx, draft)` is the only thing that writes one, and it runs
 * `validateJournalDraft` first. The database then checks the same balance
 * again at commit, so a draft that slips past this still cannot land.
 */

export interface JournalLineDraft {
  readonly accountId: string;
  /** Exactly one of debit and credit is positive; the other is zero. */
  readonly debitPoisha: Poisha;
  readonly creditPoisha: Poisha;
  /** The branch this line belongs to, for branch P&L and branch scope. */
  readonly branchId: string | null;
  readonly partyType: PartyType | null;
  readonly partyId: string | null;
  readonly memo: string | null;
}

export interface JournalDraft {
  /** The Asia/Dhaka date of the business event (invariant 8). */
  readonly businessDate: IsoDate;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly event: string;
  /** `<source_type>:<source_id>:<event>`. Posting it twice writes one journal. */
  readonly idempotencyKey: string;
  readonly memo: string | null;
  /** Set only on a reversal journal. */
  readonly reversesJournalId: string | null;
  readonly lines: readonly JournalLineDraft[];
}

/** Error codes, kept in step with `packages/contracts/src/errors.ts` by a test. */
export type LedgerErrorCode =
  | 'JOURNAL_UNBALANCED'
  | 'JOURNAL_TOO_FEW_LINES'
  | 'JOURNAL_LINE_INVALID'
  | 'JOURNAL_KEY_INVALID'
  | 'JOURNAL_DATE_INVALID'
  | 'POSTING_INPUT_INVALID';

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * The idempotency key for a business event (§7): `order:<uuid>:delivered`.
 *
 * Deterministic from the event's identity and nothing else — no timestamp,
 * no random part — so a retried job, a double-clicked button and a replayed
 * webhook all produce the same key and therefore the same single journal.
 */
export function idempotencyKey(sourceType: string, sourceId: string, event: string): string {
  if (!NAME.test(sourceType)) {
    throw new LedgerError('JOURNAL_KEY_INVALID', `Source type "${sourceType}" is not snake_case.`);
  }
  if (!isUuid(sourceId)) {
    throw new LedgerError('JOURNAL_KEY_INVALID', `Source id "${sourceId}" is not a uuid.`);
  }
  if (!NAME.test(event)) {
    throw new LedgerError('JOURNAL_KEY_INVALID', `Event "${event}" is not snake_case.`);
  }
  return `${sourceType}:${sourceId.toLowerCase()}:${event}`;
}

const MAX_MEMO = 500;
const MAX_LINES = 500;

function positive(value: Poisha): boolean {
  return value > 0n;
}

/**
 * Refuse a draft that is not a well-formed, balanced journal.
 *
 * - at least two lines, at most 500;
 * - every line has exactly one positive side and the other zero;
 * - total debits equal total credits, and are not zero;
 * - the key is exactly `<sourceType>:<sourceId>:<event>`;
 * - the business date is a real calendar date;
 * - a party is named completely or not at all.
 *
 * Whether each account exists, is active, wants a party or belongs to the
 * line's branch is a question about data, answered by the ledger service and
 * again by the database.
 */
export function validateJournalDraft(draft: JournalDraft): void {
  // Widened on purpose: the type says IsoDate, and this is the check that
  // makes the type true for a draft built from untyped input.
  const date: string = draft.businessDate;
  if (!isIsoDate(date)) {
    throw new LedgerError('JOURNAL_DATE_INVALID', `"${date}" is not a date.`);
  }

  const expectedKey = idempotencyKey(draft.sourceType, draft.sourceId, draft.event);
  if (draft.idempotencyKey !== expectedKey) {
    throw new LedgerError(
      'JOURNAL_KEY_INVALID',
      `Idempotency key "${draft.idempotencyKey}" should be "${expectedKey}".`,
    );
  }
  if (draft.reversesJournalId !== null && !isUuid(draft.reversesJournalId)) {
    throw new LedgerError('JOURNAL_KEY_INVALID', 'The reversed journal id is not a uuid.');
  }
  if (draft.memo !== null && draft.memo.length > MAX_MEMO) {
    throw new LedgerError(
      'JOURNAL_LINE_INVALID',
      `A memo is at most ${String(MAX_MEMO)} characters.`,
    );
  }

  if (draft.lines.length < 2) {
    throw new LedgerError(
      'JOURNAL_TOO_FEW_LINES',
      `A journal needs at least two lines; this one has ${String(draft.lines.length)}.`,
    );
  }
  if (draft.lines.length > MAX_LINES) {
    throw new LedgerError(
      'JOURNAL_LINE_INVALID',
      `A journal has at most ${String(MAX_LINES)} lines.`,
    );
  }

  let debits = ZERO;
  let credits = ZERO;

  draft.lines.forEach((line, index) => {
    const where = `Line ${String(index + 1)}`;
    if (typeof line.debitPoisha !== 'bigint' || typeof line.creditPoisha !== 'bigint') {
      throw new LedgerError('JOURNAL_LINE_INVALID', `${where}: amounts must be integer poisha.`);
    }
    if (line.debitPoisha < 0n || line.creditPoisha < 0n) {
      throw new LedgerError('JOURNAL_LINE_INVALID', `${where}: amounts cannot be negative.`);
    }
    if (positive(line.debitPoisha) === positive(line.creditPoisha)) {
      throw new LedgerError(
        'JOURNAL_LINE_INVALID',
        `${where}: exactly one of debit and credit must be positive.`,
      );
    }
    if (!isUuid(line.accountId)) {
      throw new LedgerError('JOURNAL_LINE_INVALID', `${where}: the account id is not a uuid.`);
    }
    if (line.branchId !== null && !isUuid(line.branchId)) {
      throw new LedgerError('JOURNAL_LINE_INVALID', `${where}: the branch id is not a uuid.`);
    }
    if ((line.partyType === null) !== (line.partyId === null)) {
      throw new LedgerError(
        'JOURNAL_LINE_INVALID',
        `${where}: a party needs both a type and an id.`,
      );
    }
    if (line.partyType !== null && !PARTY_TYPES.includes(line.partyType)) {
      throw new LedgerError('JOURNAL_LINE_INVALID', `${where}: unknown party type.`);
    }
    if (line.partyId !== null && !isUuid(line.partyId)) {
      throw new LedgerError('JOURNAL_LINE_INVALID', `${where}: the party id is not a uuid.`);
    }
    if (line.memo !== null && line.memo.length > MAX_MEMO) {
      throw new LedgerError('JOURNAL_LINE_INVALID', `${where}: memo too long.`);
    }

    debits = add(debits, line.debitPoisha);
    credits = add(credits, line.creditPoisha);
  });

  if (debits !== credits) {
    throw new LedgerError(
      'JOURNAL_UNBALANCED',
      `Debits (${debits.toString()}) do not equal credits (${credits.toString()}).`,
    );
  }
}

/**
 * A canonical rendering of everything a draft says, in a fixed order.
 *
 * `ledger.post` stores a hash of it with the journal. When the same key is
 * posted again, the replay must say the same thing: a second post of
 * `cash_in:<id>:received` with a different amount is not a retry but a
 * different event wearing a used key, and it is refused rather than
 * silently answered with the first journal (D-082).
 */
export function canonicalDraft(draft: JournalDraft): string {
  return JSON.stringify([
    draft.businessDate,
    draft.sourceType,
    draft.sourceId.toLowerCase(),
    draft.event,
    draft.idempotencyKey,
    draft.memo,
    draft.reversesJournalId,
    draft.lines.map((line) => [
      line.accountId.toLowerCase(),
      line.debitPoisha.toString(),
      line.creditPoisha.toString(),
      line.branchId?.toLowerCase() ?? null,
      line.partyType,
      line.partyId?.toLowerCase() ?? null,
      line.memo,
    ]),
  ]);
}

/** A journal as it was posted, which is all a reversal needs to know. */
export interface PostedJournal {
  readonly id: string;
  readonly reversesJournalId: string | null;
  readonly lines: readonly JournalLineDraft[];
}

/**
 * The reversal of a posted journal: every line with its sides swapped, dated
 * on the day of the correction, pointing back at the original (§7).
 *
 * Journals never change after posting (invariant 2); this is how a mistake is
 * undone. The key is `journal:<id>:reversed`, so a journal can be reversed
 * once — the database has a unique index on `reverses_journal_id` as well.
 * A reversal is not itself reversible: to reinstate, post the event again.
 */
export function reverseDraft(
  original: PostedJournal,
  input: { readonly businessDate: IsoDate; readonly reason: string },
): JournalDraft {
  if (original.reversesJournalId !== null) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A reversal cannot itself be reversed. Post the original event again instead.',
    );
  }
  const reason = input.reason.trim();
  if (reason === '') {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A reversal needs a reason.');
  }

  return {
    businessDate: input.businessDate,
    sourceType: 'journal',
    sourceId: original.id,
    event: 'reversed',
    idempotencyKey: idempotencyKey('journal', original.id, 'reversed'),
    memo: reason.slice(0, MAX_MEMO),
    reversesJournalId: original.id,
    lines: original.lines.map((line) => ({
      ...line,
      debitPoisha: line.creditPoisha,
      creditPoisha: line.debitPoisha,
    })),
  };
}
