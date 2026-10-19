import type {
  CustomerPhoneKind,
  CustomerPhoneRelation,
  CustomerPhoneRetireReason,
  CustomerPhoneSource,
  CustomerPhoneView,
} from '@elysium/contracts/customers';
import type { Tx } from '@elysium/db';
import {
  checkPhoneNote,
  needsDetails,
  pickBuyer,
  rankCandidates,
  type BuyerCandidate,
  type PhoneRelation,
  type PhoneSource,
} from '@elysium/domain';

import type { IamApi } from '../iam/iam.api.js';
import * as numbers from './numbers.repository.js';
import { OrdersError } from './orders.errors.js';

/**
 * The number rules every path shares (M48, D-870 to D-877): who a number names, the automatic
 * pick, and adding a number to a person. Plain functions in the caller's transaction, used by the
 * buyer service, the order service and `OrdersApi` alike, so the rule is one rule.
 */

/** A candidate row as the domain weighs it. */
export function asCandidate(
  row: numbers.CandidateRow,
): BuyerCandidate & { row: numbers.CandidateRow } {
  return {
    customerId: row.customer_id,
    rank: row.rank,
    relation: row.relation as PhoneRelation,
    lastOrderAt: row.last_order_at === null ? null : new Date(row.last_order_at),
    addedAt: new Date(row.added_at),
    row,
  };
}

/** Everyone a number names now, the automatic pick first (D-875). */
export async function peopleOnPhone(
  tx: Tx,
  orgId: string,
  phoneE164: string,
): Promise<(BuyerCandidate & { row: numbers.CandidateRow })[]> {
  const rows = await numbers.candidatesByPhone(tx, orgId, phoneE164);
  return rankCandidates(rows.map(asCandidate));
}

/**
 * The person an automatic path takes a number to mean (D-876), and whether it had to choose
 * among several (the order is then flagged "check the buyer: shared number").
 */
export async function pickPersonByPhone(
  tx: Tx,
  orgId: string,
  phoneE164: string,
): Promise<{ readonly customerId: string; readonly shared: boolean } | undefined> {
  const rows = await numbers.candidatesByPhone(tx, orgId, phoneE164);
  const pick = pickBuyer(rows.map(asCandidate));
  if (pick.kind === 'none') return undefined;
  return { customerId: pick.customerId, shared: pick.kind === 'several' };
}

/** Where an order's new number came from (D-871): the website, an inbox chat, or an order. */
export function sourceForOrder(
  channel: string,
  source: { readonly inboxConversationId?: string | undefined } | undefined,
): PhoneSource {
  if (source?.inboxConversationId !== undefined) return 'inbox';
  if (channel === 'website') return 'website';
  return 'order';
}

/**
 * Put a number on a person, unless they use it already (D-870, D-871): at the end of their list,
 * or as rank 1 for a person with none. The note is the domain's rule: staff on the Numbers card
 * must write one; an automatic path may leave it for staff ("needs details"). A number the person
 * already uses comes back as it is, its note written if it had none and one was given.
 */
export async function addNumber(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly phoneE164: string;
    readonly kind?: string;
    readonly relation: PhoneRelation;
    readonly note?: string | null | undefined;
    readonly source: PhoneSource;
    readonly addedByUserId: string | null;
  },
): Promise<{ readonly id: string; readonly added: boolean }> {
  const note = checkPhoneNote(input.note, input.source);
  if (!note.ok) {
    throw new OrdersError(
      'CUSTOMER_PHONE_INVALID',
      note.reason === 'note_required'
        ? 'Write why and when this person uses the number.'
        : 'A number’s note is at most 500 characters.',
    );
  }
  const active = await numbers.activePhonesOf(tx, input.orgId, input.customerId, {
    forUpdate: true,
  });
  const existing = active.find((phone) => phone.phone_e164 === input.phoneE164);
  if (existing !== undefined) {
    if (existing.note === null && note.note !== null) {
      await numbers.updatePhoneDetails(tx, input.orgId, existing.id, { note: note.note });
    }
    return { id: existing.id, added: false };
  }
  const id = await numbers.insertPhone(tx, {
    orgId: input.orgId,
    customerId: input.customerId,
    phoneE164: input.phoneE164,
    rank: active.length + 1,
    kind: input.kind ?? 'mobile',
    relation: input.relation,
    note: note.note,
    source: input.source,
    // A worker's `system:…` actor is nobody to name (and no `iam.users` row).
    addedByUserId:
      input.addedByUserId !== null && (await numbers.isPerson(tx, input.addedByUserId))
        ? input.addedByUserId
        : null,
  });
  if (active.length === 0) await numbers.syncPrimaryCopy(tx, input.orgId, input.customerId);
  return { id, added: true };
}

/** A person's numbers as the Numbers card shows them: in use by rank, then retired (D-871). */
export async function phoneViews(
  tx: Tx,
  iam: IamApi,
  orgId: string,
  customerId: string,
): Promise<CustomerPhoneView[]> {
  const rows = await numbers.phonesOf(tx, orgId, customerId);
  const nameOf = await iam.nameBook(tx, orgId);
  const person = (id: string | null) => (id === null ? null : { id, name: nameOf.get(id) ?? null });
  return rows.map((row) => ({
    id: row.id,
    phone: row.phone_e164,
    rank: row.rank,
    kind: row.kind as CustomerPhoneKind,
    relation: row.relation as CustomerPhoneRelation,
    note: row.note,
    needsDetails: needsDetails(row),
    source: row.source as CustomerPhoneSource,
    addedBy: person(row.added_by_user_id),
    addedAt: new Date(row.added_at).toISOString(),
    retired:
      row.retired_at === null
        ? null
        : {
            at: new Date(row.retired_at).toISOString(),
            reason: (row.retire_reason ?? 'other') as CustomerPhoneRetireReason,
            note: row.retire_note,
            by: person(row.retired_by_user_id),
          },
  }));
}
