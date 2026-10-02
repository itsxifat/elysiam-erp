import { Injectable } from '@nestjs/common';
import { serializeFor } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, maskPhone, poisha, toIsoDate, type Poisha } from '@elysium/domain';
import {
  investorPosition,
  withdrawableFor,
  type InvestorPosition,
} from '@elysium/domain/investors';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeOf, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './investors.repository.js';
import { investorsHttpError, mapInvestorErrors } from './investors.errors.js';
import type { CreateInvestorInput, UpdateInvestorInput } from './investors.schemas.js';

/**
 * Investor profiles, positions and statements (architecture §15, §6).
 *
 * Three things here are the milestone's checks rather than plumbing:
 *
 * 1. **An investor sees only their own rows** (check 1). §6 gives the `investor`
 *    role `read Investor` at `own` scope, and `own` for this subject means one
 *    thing: the investor row whose `user_id` is the caller. Every read in this
 *    module applies that filter through `scopeWhere` on the **investor** row and
 *    joins everything else to it, so a withdrawal, a document and a distribution
 *    line are all reachable only through an investor the caller may see. The
 *    filter is mandatory, not advisory — `ScopeInterceptor` refuses to send a
 *    scoped caller's response if the handler applied nothing.
 * 2. **A position is derived, never stored.** Contributions less capital paid,
 *    profit declared less profit paid, with lock-in applied per contribution. The
 *    arithmetic is `investorPosition` in the domain, so the API, the statement and
 *    the withdrawal check cannot disagree about what an investor holds.
 * 3. **Responses go through `serializeFor`.** Nothing here is a cost field today,
 *    and that is exactly why it is wired now: the first person to add "profit
 *    margin this period" to an investor statement should find the strip already in
 *    place (invariant 5).
 */

export interface InvestorView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly userId: string | null;
  readonly phoneMasked: string | null;
  readonly email: string | null;
  readonly shareBps: number;
  readonly status: string;
  readonly joinedOn: string;
  readonly notes: string | null;
}

export interface PositionView {
  readonly contributedPoisha: string;
  readonly capitalWithdrawnPoisha: string;
  readonly capitalPoisha: string;
  readonly lockedPoisha: string;
  readonly withdrawableCapitalPoisha: string;
  readonly declaredPoisha: string;
  readonly profitPaidPoisha: string;
  readonly payablePoisha: string;
}

export interface InvestorWithPosition extends InvestorView {
  readonly position: PositionView;
}

export function investorView(row: repo.InvestorRow): InvestorView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    userId: row.user_id,
    phoneMasked: row.phone_masked,
    email: row.email,
    shareBps: row.share_bps,
    status: row.status,
    joinedOn: row.joined_on,
    notes: row.notes,
  };
}

/**
 * The profile as this caller may see it (D-315).
 *
 * `notes` is the brand's own free text about an investor — written by accounts, read by
 * accounts — and an investor reading their own row is not its audience. Anyone whose
 * `read Investor` is narrower than the whole org gets it as `null`, so the field keeps its
 * shape and the console's staff screens are unchanged.
 */
export function investorViewFor(request: object, row: repo.InvestorRow): InvestorView {
  const view = investorView(row);
  return scopeOf(request).kind === 'all' ? view : { ...view, notes: null };
}

export function positionView(position: InvestorPosition): PositionView {
  return {
    contributedPoisha: position.contributedPoisha.toString(),
    capitalWithdrawnPoisha: position.capitalWithdrawnPoisha.toString(),
    capitalPoisha: position.capitalPoisha.toString(),
    lockedPoisha: position.lockedPoisha.toString(),
    withdrawableCapitalPoisha: position.withdrawableCapitalPoisha.toString(),
    declaredPoisha: position.declaredPoisha.toString(),
    profitPaidPoisha: position.profitPaidPoisha.toString(),
    payablePoisha: position.payablePoisha.toString(),
  };
}

/**
 * The scope columns for a query that reaches investors through `i`.
 *
 * **Both `own` conditions point at `user_id`, and that is deliberate.** `own`
 * yields a `createdBy` condition and an `assignedTo` condition, OR'd; for this
 * subject there is only one notion of "own" — the investor row that *is* the
 * caller. Mapping `createdBy` to `i.created_by` would instead mean "an investor
 * row this person created", which an investor can never do today and which would
 * quietly widen the moment somebody granted them `create Investor`.
 */
export function investorScope(request: object): ReturnType<typeof scopeWhere> {
  return scopeWhere(request, { createdBy: sql`i.user_id`, assignedTo: sql`i.user_id` });
}

/**
 * Refuse a caller whose `read Investor` does not reach the whole org.
 *
 * For the two distribution endpoints, which are about the org's profit rather than
 * about one investor's position. A distribution's total is what the company declared
 * and its lines say what every investor got — so narrowing it per caller would mean
 * showing an investor a total that is not theirs and a list of lines with everybody
 * else's removed, which is a worse answer than none. Their own share is in their
 * statement, as a declared-profit entry.
 *
 * `investorScope` is called for its effect as well as its value: `ScopeInterceptor`
 * refuses to send a scoped caller's response unless the handler applied the scope,
 * and here the application *is* the refusal rather than a narrower query.
 */
export function assertOrgWideInvestorReach(request: object): void {
  const filter = scopeOf(request);
  investorScope(request);
  if (filter.kind !== 'all') {
    throw investorsHttpError(
      'FORBIDDEN',
      'Distributions are the organization’s record. Your own share is on your statement.',
    );
  }
}

/**
 * The rows a position is derived from, turned into the position.
 *
 * A free function so the single-investor read and the batched list read share one
 * definition — two copies of "what these rows mean" is how a list ends up
 * disagreeing with the row it links to. `undefined` is an investor with no rows at
 * all, which is a real state (added today, nothing contributed yet) and not an
 * error: `investorPosition` of nothing is a position of zero.
 */
function positionOf(rows: repo.PositionRows | undefined, onDate: string): InvestorPosition {
  return investorPosition({
    lots: (rows?.lots ?? []).map((lot) => ({
      amountPoisha: poisha(lot.amount_poisha),
      lockInUntil: lot.lock_in_until === null ? null : toIsoDate(lot.lock_in_until),
    })),
    capitalPaidPoisha: (rows?.capitalPaid ?? []).map((amount) => poisha(amount)),
    declaredPoisha: (rows?.declared ?? []).map((amount) => poisha(amount)),
    profitPaidPoisha: (rows?.profitPaid ?? []).map((amount) => poisha(amount)),
    onDate: toIsoDate(onDate),
  });
}

@Injectable()
export class InvestorsService {
  constructor(private readonly audit: AuditService) {}

  async list(
    context: ActiveContext,
    request: object,
    query: { readonly includeExited?: boolean | undefined },
  ): Promise<{ items: readonly InvestorWithPosition[] }> {
    const scope = investorScope(request);
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listInvestors(tx, context.orgId, {
          scope,
          includeExited: query.includeExited ?? false,
        });
        /*
         * One batched read for every position on the page, rather than four queries
         * per investor. A position is derived, so the list has to compute one for
         * each row — twenty investors was eighty round trips for a screen that
         * changes once a quarter.
         */
        const today = businessDate(new Date());
        const positions = await repo.positionRowsFor(
          tx,
          context.orgId,
          rows.map((row) => row.id),
        );
        const items: InvestorWithPosition[] = rows.map((row) => ({
          ...investorViewFor(request, row),
          position: positionView(positionOf(positions.get(row.id), today)),
        }));
        return serializeFor(context, 'Investor', { items });
      }),
    );
  }

  async get(
    context: ActiveContext,
    request: object,
    investorId: string,
  ): Promise<InvestorWithPosition> {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await this.requireInvestor(tx, context, request, investorId);
        return serializeFor(context, 'Investor', {
          ...investorViewFor(request, row),
          position: positionView(await this.positionOf(tx, context, row.id)),
        });
      }),
    );
  }

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateInvestorInput,
  ): Promise<InvestorView> {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (input.userId !== undefined) {
          await this.assertInvestorLogin(tx, context, input.userId);
        }

        const id = await repo.insertInvestor(tx, {
          orgId: context.orgId,
          code: input.code.trim().toUpperCase(),
          name: input.name,
          userId: input.userId ?? null,
          // Masked on the way in. A column that accepts a full number receives
          // one, and it is then in every backup and export (invariant 10).
          phoneMasked: input.phone === undefined ? null : maskPhone(input.phone),
          email: input.email ?? null,
          shareBps: input.shareBps,
          joinedOn: input.joinedOn,
          notes: input.notes ?? null,
          createdBy: context.userId,
        });

        const row = await repo.investorById(tx, context.orgId, id);
        if (row === undefined) throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such investor.');

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'investors.investor.created',
          entityType: 'Investor',
          entityId: id,
          before: null,
          // No phone, no email: the audit log is read by more people than the
          // investor list is, and `AuditService` redacts on the way in anyway.
          after: {
            code: row.code,
            name: row.name,
            shareBps: row.share_bps,
            linked: row.user_id !== null,
          },
          requestId: context.requestId,
          request,
        });

        return serializeFor(context, 'Investor', investorView(row));
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    investorId: string,
    patch: UpdateInvestorInput,
  ): Promise<InvestorView> {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await repo.investorById(tx, context.orgId, investorId);
        if (before === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such investor.');
        }
        if (patch.userId !== undefined) {
          await this.assertInvestorLogin(tx, context, patch.userId);
        }

        await repo.updateInvestor(tx, context.orgId, investorId, {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.userId === undefined ? {} : { userId: patch.userId }),
          ...(patch.phone === undefined
            ? {}
            : { phoneMasked: patch.phone === null ? null : maskPhone(patch.phone) }),
          ...(patch.email === undefined ? {} : { email: patch.email }),
          ...(patch.shareBps === undefined ? {} : { shareBps: patch.shareBps }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
        });

        const after = await repo.investorById(tx, context.orgId, investorId);
        if (after === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such investor.');
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'investors.investor.updated',
          entityType: 'Investor',
          entityId: investorId,
          before: { name: before.name, shareBps: before.share_bps, status: before.status },
          after: { name: after.name, shareBps: after.share_bps, status: after.status },
          requestId: context.requestId,
          request,
        });

        return serializeFor(context, 'Investor', investorView(after));
      }),
    );
  }

  /**
   * An investor's statement over a range of business dates (§15).
   *
   * Built from this module's own rows rather than from `ledger.journal_lines`, and
   * the two agree by construction: every row in it names the journal that moved
   * the money, and a journal never changes after posting. Reading the ledger
   * directly would also mean reading another module's tables, which invariant 12
   * does not allow — the ledger's party statement is its own endpoint.
   */
  async statement(
    context: ActiveContext,
    request: object,
    investorId: string,
    range: { readonly from: string; readonly to: string },
  ) {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const investor = await this.requireInvestor(tx, context, request, investorId);

        const contributions = (
          await repo.listInvestments(tx, context.orgId, {
            scope: sql`true`,
            investorId: investor.id,
          })
        ).filter((row) => row.business_date >= range.from && row.business_date <= range.to);

        const withdrawals = (
          await repo.listWithdrawals(tx, context.orgId, {
            scope: sql`true`,
            investorId: investor.id,
            status: 'paid',
          })
        ).filter(
          (row) => row.paid_on !== null && row.paid_on >= range.from && row.paid_on <= range.to,
        );

        const declared = await repo.declaredLinesFor(tx, context.orgId, investor.id, range);

        /*
         * One chronological list, because that is what a statement is. Each entry
         * says what moved and names its journal, so a question about any line is
         * answerable in the day book.
         */
        const entries = [
          ...contributions.map((row) => ({
            date: row.business_date,
            kind: 'contribution' as const,
            amountPoisha: row.amount_poisha,
            reference: row.id,
            journalId: row.journal_id,
            note: row.memo,
          })),
          ...declared.map((row) => ({
            date: row.declared_on,
            kind: 'distribution' as const,
            amountPoisha: row.amount_poisha,
            reference: row.distribution_id,
            journalId: row.journal_id,
            note: row.memo,
          })),
          ...withdrawals.map((row) => ({
            date: row.paid_on ?? range.to,
            kind:
              row.kind === 'capital' ? ('capital_withdrawal' as const) : ('profit_paid' as const),
            amountPoisha: row.amount_poisha,
            reference: row.id,
            journalId: row.journal_id,
            note: row.reason,
          })),
        ].sort((a, b) =>
          a.date === b.date ? a.kind.localeCompare(b.kind) : a.date < b.date ? -1 : 1,
        );

        return serializeFor(context, 'Investor', {
          investor: investorViewFor(request, investor),
          from: range.from,
          to: range.to,
          entries,
          // The position as it stands today, not as at `to`: an investor asking
          // for a statement wants to know what they hold now, and a lock-in that
          // has since expired should read as expired.
          position: positionView(await this.positionOf(tx, context, investor.id)),
        });
      }),
    );
  }

  /** The wallet accounts a contribution or a payment may name (§7). */
  async walletAccounts(context: ActiveContext) {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        serializeFor(context, 'Investor', {
          items: (await repo.walletAccounts(tx, context.orgId)).map((row) => ({
            id: row.id,
            code: row.code,
            name: row.name,
            subtype: row.subtype,
            branchId: row.branch_id,
          })),
        }),
      ),
    );
  }

  // --- shared by the other services in this module ---------------------------

  /**
   * The investor a caller named, refusing one they may not see.
   *
   * Out of scope answers exactly as missing. Any other answer is a way for one
   * investor to learn that another exists, which is the oracle §6's "investors
   * only ever see rows where `investor_id` is their own" exists to close.
   */
  async requireInvestor(
    tx: Tx,
    context: ActiveContext,
    request: object,
    investorId: string,
  ): Promise<repo.InvestorRow> {
    const row = await repo.investorById(tx, context.orgId, investorId);
    if (row === undefined) throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such investor.');
    try {
      assertInScope(request, { createdBy: row.user_id, assignedTo: row.user_id });
    } catch {
      throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such investor.');
    }
    return row;
  }

  /** The derived position, from the rows it is derived from. */
  async positionOf(
    tx: Tx,
    context: ActiveContext,
    investorId: string,
    onDate = businessDate(new Date()),
  ): Promise<InvestorPosition> {
    return positionOf(await repo.positionRows(tx, context.orgId, investorId), onDate);
  }

  /**
   * What is left to withdraw of one kind, after the requests already in flight.
   *
   * The position alone is not the ceiling. Three ৳1,00,000 requests against
   * ৳1,50,000 of capital would each pass on their own and the third would be paid
   * out of nothing — the journal would post, because a capital account is
   * perfectly capable of going negative, and the balance sheet would be the only
   * place it showed up.
   */
  async headroomFor(
    tx: Tx,
    context: ActiveContext,
    investorId: string,
    kind: 'capital' | 'profit',
  ): Promise<{
    readonly position: InvestorPosition;
    /** Everything already requested, reviewed or approved and not yet paid. */
    readonly openPoisha: Poisha;
    /** What a **new** request may still ask for. Never negative. */
    readonly availablePoisha: Poisha;
  }> {
    const position = await this.positionOf(tx, context, investorId);
    const open = poisha(await repo.openWithdrawnPoisha(tx, context.orgId, investorId, kind));
    const free = withdrawableFor(position, kind) - open;
    return { position, openPoisha: open, availablePoisha: poisha(free < 0n ? 0n : free) };
  }

  private async assertInvestorLogin(tx: Tx, context: ActiveContext, userId: string): Promise<void> {
    if (!(await repo.hasInvestorMembership(tx, context.orgId, userId))) {
      throw investorsHttpError(
        'VALIDATION_FAILED',
        'That user does not hold an investor role in this organization. Grant it first.',
      );
    }
  }
}
