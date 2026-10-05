import { Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha } from '@elysium/domain';
import { drawerVariance, expectedDrawerCash } from '@elysium/domain/pos';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { posHttpError } from './pos.errors.js';
import * as repo from './pos.repository.js';
import type { CloseShiftInput, OpenShiftInput } from './pos.schemas.js';
import { branchIsActive } from './references.repository.js';

/**
 * Shifts: a float counted in, a drawer counted out (§14).
 *
 * Opening posts nothing and neither does closing. The float was already in the
 * branch's hand cash, and the drawer variance is the cashier's accountability,
 * not the ledger's: the books are reconciled once a day by the branch closing,
 * through M08's `closing_variance` approval. A shift variance posted as well would
 * count the same missing note twice.
 */

export interface ShiftView {
  readonly id: string;
  readonly registerId: string;
  readonly registerCode: string;
  readonly branchId: string;
  readonly shiftNo: number;
  readonly status: 'open' | 'closed';
  readonly openedBy: string;
  readonly openedAt: string;
  readonly businessDate: string;
  readonly openingFloatPoisha: string;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly countedCashPoisha: string | null;
  readonly expectedCashPoisha: string | null;
  readonly variancePoisha: string | null;
  readonly note: string | null;
}

export function shiftView(row: repo.ShiftRow): ShiftView {
  return {
    id: row.id,
    registerId: row.register_id,
    registerCode: row.register_code,
    branchId: row.branch_id,
    shiftNo: row.shift_no,
    status: row.status,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    businessDate: row.business_date,
    openingFloatPoisha: row.opening_float_poisha,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    countedCashPoisha: row.counted_cash_poisha,
    expectedCashPoisha: row.expected_cash_poisha,
    variancePoisha: row.variance_poisha,
    note: row.close_note,
  };
}

@Injectable()
export class ShiftsService {
  constructor(private readonly audit: AuditService) {}

  async open(
    context: ActiveContext,
    request: AuditableRequest,
    input: OpenShiftInput,
  ): Promise<ShiftView> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const register = await repo.registerById(tx, context.orgId, input.registerId);
      if (register === undefined) throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such register.');
      try {
        assertInScope(request, { branchId: register.branch_id });
      } catch {
        throw posHttpError('POS_REGISTER_NOT_FOUND', 'No such register.');
      }
      if (!register.is_active) {
        throw posHttpError('POS_REGISTER_INVALID', 'That register is deactivated.');
      }
      // M39a (D-633): a switched-off branch opens no shift.
      if (!(await branchIsActive(tx, context.orgId, register.branch_id))) {
        throw posHttpError('POS_REGISTER_INVALID', 'That branch is switched off.');
      }

      // A retried open — the reply was lost on the way back — is the same shift.
      const already = await repo.shiftById(tx, context.orgId, input.shiftId);
      if (already !== undefined) {
        if (
          already.register_id !== register.id ||
          already.opened_by !== context.userId ||
          already.opening_float_poisha !== input.openingFloatPoisha
        ) {
          throw posHttpError('IDEMPOTENCY_CONFLICT', 'A different shift already has that id.');
        }
        return shiftView(already);
      }

      const open = await repo.openShiftOn(tx, context.orgId, register.id);
      if (open !== undefined) {
        throw posHttpError(
          'POS_SHIFT_ALREADY_OPEN',
          `Shift ${String(open.shift_no)} is still open on this register; close it first.`,
        );
      }

      const now = new Date();
      const shiftNo = await repo.nextShiftNo(tx, context.orgId, register.id);
      await repo.insertShift(tx, {
        orgId: context.orgId,
        id: input.shiftId,
        registerId: register.id,
        branchId: register.branch_id,
        shiftNo,
        openedBy: context.userId,
        openedAt: now,
        businessDate: businessDate(now),
        openingFloatPoisha: BigInt(input.openingFloatPoisha),
      });
      const row = await this.row(tx, context.orgId, input.shiftId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'pos.shift.opened',
        entityType: 'PosShift',
        entityId: row.id,
        before: null,
        after: { registerId: register.id, shiftNo, openingFloatPoisha: input.openingFloatPoisha },
        requestId: context.requestId,
        request,
      });
      return shiftView(row);
    });
  }

  /**
   * Count the drawer and close the shift.
   *
   * The expected figure is derived here from the shift's own documents, never
   * sent: a client-supplied expectation lets anyone make a shortfall vanish by
   * sending the number that makes it zero (the same reason M08 derives its own).
   * The till refuses to offer close while its queue holds unsynced sales; a sale
   * that arrives afterwards anyway is held as `shift_closed` for the manager, so
   * the count it missed is visible rather than silently wrong.
   */
  async close(
    context: ActiveContext,
    request: AuditableRequest,
    shiftId: string,
    input: CloseShiftInput,
  ): Promise<ShiftView & { readonly drawer: DrawerView }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const shift = await repo.shiftById(tx, context.orgId, shiftId, true);
      if (shift === undefined) throw posHttpError('POS_SHIFT_NOT_OPEN', 'No such shift.');
      try {
        assertInScope(request, { branchId: shift.branch_id });
      } catch {
        throw posHttpError('POS_SHIFT_NOT_OPEN', 'No such shift.');
      }
      if (shift.status === 'closed') {
        if (shift.counted_cash_poisha === input.countedCashPoisha) {
          // The same count sent twice: the first close stands.
          return { ...shiftView(shift), drawer: await this.drawer(tx, context.orgId, shift) };
        }
        throw posHttpError('POS_SHIFT_NOT_OPEN', 'That shift is already closed and counted.');
      }

      const drawer = await this.drawer(tx, context.orgId, shift);
      const counted = poisha(input.countedCashPoisha);
      const expected = poisha(drawer.expectedCashPoisha);
      const variance = drawerVariance(counted, expected);
      await repo.closeShift(tx, context.orgId, shift.id, {
        closedBy: context.userId,
        countedCashPoisha: counted,
        expectedCashPoisha: expected,
        variancePoisha: variance,
        note: input.note ?? null,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'pos.shift.closed',
        entityType: 'PosShift',
        entityId: shift.id,
        before: { status: 'open' },
        after: {
          status: 'closed',
          countedCashPoisha: counted.toString(),
          expectedCashPoisha: expected.toString(),
          variancePoisha: variance.toString(),
        },
        requestId: context.requestId,
        request,
      });
      const closed = await this.row(tx, context.orgId, shift.id);
      return { ...shiftView(closed), drawer };
    });
  }

  async list(
    context: ActiveContext,
    request: object,
    filter: {
      branchId?: string | undefined;
      registerId?: string | undefined;
      status?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<{ items: ShiftView[] }> {
    const scope = scopeWhere(request, { branchId: sql`s.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.shifts(tx, context.orgId, { scope, ...filter })).map(shiftView),
    }));
  }

  async get(context: ActiveContext, request: object, shiftId: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const shift = await repo.shiftById(tx, context.orgId, shiftId);
      if (shift === undefined) throw posHttpError('POS_SHIFT_NOT_OPEN', 'No such shift.');
      try {
        assertInScope(request, { branchId: shift.branch_id });
      } catch {
        throw posHttpError('POS_SHIFT_NOT_OPEN', 'No such shift.');
      }
      return { ...shiftView(shift), drawer: await this.drawer(tx, context.orgId, shift) };
    });
  }

  private async drawer(tx: Tx, orgId: string, shift: repo.ShiftRow): Promise<DrawerView> {
    const totals = await repo.drawerTotals(tx, orgId, shift.id);
    const expected = expectedDrawerCash({
      openingFloatPoisha: poisha(shift.opening_float_poisha),
      cashSalesPoisha: poisha(totals.cash_sales_poisha),
      cashRefundsPoisha: poisha(totals.cash_refunds_poisha),
    });
    return {
      openingFloatPoisha: shift.opening_float_poisha,
      cashSalesPoisha: totals.cash_sales_poisha,
      cashRefundsPoisha: totals.cash_refunds_poisha,
      expectedCashPoisha: expected.toString(),
      salesCount: totals.sales_count,
      heldCount: totals.held_count,
      netSalesPoisha: totals.net_sales_poisha,
      refundsPoisha: totals.refunds_poisha,
    };
  }

  private async row(tx: Tx, orgId: string, id: string): Promise<repo.ShiftRow> {
    const row = await repo.shiftById(tx, orgId, id);
    if (row === undefined) throw new Error('a shift written in this transaction is not visible');
    return row;
  }
}

export interface DrawerView {
  readonly openingFloatPoisha: string;
  readonly cashSalesPoisha: string;
  readonly cashRefundsPoisha: string;
  readonly expectedCashPoisha: string;
  readonly salesCount: number;
  readonly heldCount: number;
  readonly netSalesPoisha: string;
  readonly refundsPoisha: string;
}
