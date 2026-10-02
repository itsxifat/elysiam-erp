import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { addDays, businessDate, toIsoDate } from '@elysium/domain';
import {
  addMonths,
  daysInMonth,
  toPayrollMonth,
  type PayrollMonth,
  type WorkCalendar,
} from '@elysium/domain/payroll';
import {
  deskEventFrom,
  movesTargets,
  pctBps,
  productivity,
  rollupProgress,
  splitTarget,
  type AgentProductivity,
  type DeskEvent,
  type DeskEventKind,
  type Progress,
  type TargetMetric,
} from '@elysium/domain/targets';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { DeliveredEvent } from '../../platform/events/dispatcher.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { HrError, mapHrErrors } from './hr.errors.js';
import * as hrRepo from './hr.repository.js';
import * as repo from './performance.repository.js';
import type { CreateTargetInput, ProductivityQuery, TargetQuery } from './performance.schemas.js';

/**
 * Targets, their progress and the order desk's productivity (architecture §12; M20).
 *
 * A target is set once and never edited (0083): its month, metric, people, value and
 * weekly split are what the agent was shown on the first of the month. What moves is
 * `achieved`, recomputed from the orders the members confirmed and delivered
 * (`OrdersApi.agentResults`, D-272) by `rollupProgress`. When a figure moves, the
 * transaction that moved it emits `target.progress` to the members and to HR (§19).
 *
 * ## Who sees what (D-278)
 *
 * Every read declares `read Target`, which §6 gives sales and marketing at `own`, a branch
 * manager at `branch` and hr and org_admin across the org. `own` means "a target that
 * counts me" (`memberColumn`), and the productivity report is a list of employees, scoped
 * through the employee rows — so an agent sees one row, theirs (M20 check 4).
 */

/** The worker's actor when it refreshes progress. Not a person. */
export const PROGRESS_ACTOR = 'usr_targets_refresh';

export interface WeekView {
  readonly weekNo: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly workingDays: number;
  readonly planned: string;
  readonly achieved: string;
}

export interface TargetView {
  readonly id: string;
  readonly month: string;
  readonly metric: string;
  readonly scope: string;
  readonly employeeId: string | null;
  readonly employeeCode: string | null;
  readonly employeeName: string | null;
  readonly teamName: string | null;
  readonly branchId: string | null;
  /** Orders, or poisha for `delivered_revenue`, as a decimal string. */
  readonly targetValue: string;
  readonly achieved: string;
  /** Achieved over target in basis points, rounded down. */
  readonly pctBps: number;
  readonly progressAt: string | null;
  readonly status: string;
  readonly note: string | null;
  readonly members: readonly {
    readonly employeeId: string;
    readonly code: string;
    readonly name: string;
  }[];
  readonly weeks: readonly WeekView[];
}

export interface ProductivityRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly branchId: string | null;
  readonly pickups: number;
  readonly medianPickupSeconds: number | null;
  readonly p90PickupSeconds: number | null;
  readonly handledOrders: number;
  readonly activeHours: number;
  readonly ordersPerActiveHour: number | null;
}

/** This Asia/Dhaka month. */
export function currentMonth(now: Date = new Date()): PayrollMonth {
  return toPayrollMonth(businessDate(now).slice(0, 7));
}

function lastDay(month: string): string {
  return `${month}-${String(daysInMonth(toPayrollMonth(month))).padStart(2, '0')}`;
}

/** The instant an Asia/Dhaka date begins. */
function dhakaMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+06:00`);
}

@Injectable()
export class TargetsService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly audit: AuditService,
  ) {}

  /** The scope columns for a target row (§6 `own` and `branch`, D-278). */
  private targetScope(request: object, userId: string) {
    const member = repo.memberColumn(userId);
    return scopeWhere(request, {
      branchId: sql`t.branch_id`,
      assignedTo: member,
      createdBy: member,
    });
  }

  // --- reads -------------------------------------------------------------------

  async list(
    context: ActiveContext,
    request: object,
    query: TargetQuery,
  ): Promise<{ items: TargetView[] }> {
    const scope = this.targetScope(request, context.userId);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listTargets(tx, context.orgId, {
        scope,
        month: query.month,
        employeeId: query.employeeId,
        status: query.status,
      });
      return { items: await this.views(tx, context.orgId, rows) };
    });
  }

  async get(context: ActiveContext, request: object, id: string): Promise<TargetView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await this.scoped(tx, context, request, id);
        const [view] = await this.views(tx, context.orgId, [row]);
        if (view === undefined) throw new HrError('HR_NOT_FOUND', 'No such target.');
        return view;
      }),
    );
  }

  /**
   * One target, checked against the caller's scope; 404 outside it, like an employee.
   */
  private async scoped(
    tx: Tx,
    context: ActiveContext,
    request: object,
    id: string,
  ): Promise<repo.TargetRow> {
    const row = await repo.targetById(tx, context.orgId, id);
    if (row === undefined) throw new HrError('HR_NOT_FOUND', 'No such target.');
    const members = await repo.membersOf(tx, context.orgId, [row.id]);
    const isMember = members.some((member) => member.user_id === context.userId);
    assertInScope(request, {
      branchId: row.branch_id,
      createdBy: isMember ? context.userId : null,
      assignedTo: isMember ? context.userId : null,
    });
    return row;
  }

  private async views(
    tx: Tx,
    orgId: string,
    rows: readonly repo.TargetRow[],
  ): Promise<TargetView[]> {
    const ids = rows.map((row) => row.id);
    const members = await repo.membersOf(tx, orgId, ids);
    const weeks = await repo.weeksOf(tx, orgId, ids);
    return rows.map((row) => ({
      id: row.id,
      month: row.month,
      metric: row.metric,
      scope: row.scope,
      employeeId: row.employee_id,
      employeeCode: row.employee_code,
      employeeName: row.employee_name,
      teamName: row.team_name,
      branchId: row.branch_id,
      targetValue: row.target_value,
      achieved: row.achieved,
      pctBps: pctBps(BigInt(row.achieved), BigInt(row.target_value)),
      progressAt: row.progress_at,
      status: row.status,
      note: row.note,
      members: members
        .filter((member) => member.target_id === row.id)
        .map((member) => ({
          employeeId: member.employee_id,
          code: member.code,
          name: member.full_name,
        })),
      weeks: weeks
        .filter((week) => week.target_id === row.id)
        .map((week) => ({
          weekNo: week.week_no,
          startsOn: week.starts_on,
          endsOn: week.ends_on,
          workingDays: week.working_days,
          planned: week.planned,
          achieved: week.achieved,
        })),
    }));
  }

  // --- writes ------------------------------------------------------------------

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateTargetInput,
  ): Promise<TargetView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const month = toPayrollMonth(input.month);
        const memberIds =
          input.scope === 'employee' ? [input.employeeId] : [...new Set(input.memberIds)];

        const employees: hrRepo.EmployeeRow[] = [];
        for (const id of memberIds) {
          const employee = await hrRepo.employeeById(tx, context.orgId, id);
          if (employee === undefined) {
            throw new HrError('HR_NOT_FOUND', 'No such employee in this brand.');
          }
          employees.push(employee);
        }
        const first = employees[0];
        if (first === undefined) throw new HrError('TARGET_INVALID', 'A target counts somebody.');

        const branchId = input.scope === 'employee' ? first.branch_id : (input.branchId ?? null);
        // `create Target` is org-wide for hr and org_admin, the only holders (§6); asserted
        // anyway, because a create is scoped too (D-061).
        assertInScope(request, { branchId, createdBy: context.userId });

        /*
         * The split uses the employee's own calendar — a six-day showroom and a five-day
         * head office plan their weeks differently (D-187) — and a team's uses the brand's
         * default, since its members may not share one (D-271).
         */
        const fallback = await hrRepo.ensureDefaultCalendar(tx, context.orgId);
        const calendarId =
          input.scope === 'employee' ? (first.calendar_id ?? fallback.id) : fallback.id;
        const calendar = await this.calendar(tx, context.orgId, calendarId, month);
        const total = BigInt(input.targetValue);
        const plan = splitTarget(total, month, calendar);

        const id = await repo.insertTarget(tx, {
          orgId: context.orgId,
          month,
          metric: input.metric,
          scope: input.scope,
          employeeId: input.scope === 'employee' ? first.id : null,
          teamName: input.scope === 'team' ? input.teamName : null,
          branchId,
          calendarId,
          targetValue: total,
          note: input.note ?? null,
          createdBy: context.userId,
        });
        for (const employee of employees) {
          await repo.insertTargetMember(tx, context.orgId, id, employee.id);
        }
        for (const week of plan) {
          await repo.insertTargetWeek(tx, {
            orgId: context.orgId,
            targetId: id,
            weekNo: week.weekNo,
            startsOn: week.startsOn,
            endsOn: week.endsOn,
            workingDays: week.workingDays,
            planned: week.planned,
          });
        }

        // Progress from the first moment, so a target set mid-month opens with what the
        // members have already done rather than a zero that corrects itself later.
        const row = await repo.targetById(tx, context.orgId, id);
        if (row === undefined) throw new Error('a target vanished inside its own transaction');
        await this.applyProgress(tx, context.orgId, [row]);

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.target.created',
          entityType: 'Target',
          entityId: id,
          before: null,
          after: {
            month,
            metric: input.metric,
            scope: input.scope,
            memberIds,
            targetValue: input.targetValue,
            weeks: plan.map((week) => week.planned.toString()),
          },
          requestId: context.requestId,
          request,
        });

        const fresh = await repo.targetById(tx, context.orgId, id);
        const [view] = await this.views(tx, context.orgId, fresh === undefined ? [] : [fresh]);
        if (view === undefined) throw new Error('a target vanished inside its own transaction');
        return view;
      }),
    );
  }

  async cancel(context: ActiveContext, request: AuditableRequest, id: string): Promise<TargetView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.targetById(tx, context.orgId, id, { forUpdate: true });
        if (row === undefined) throw new HrError('HR_NOT_FOUND', 'No such target.');
        assertInScope(request, { branchId: row.branch_id, createdBy: row.created_by });
        if (row.status === 'cancelled') {
          throw new HrError('TARGET_FROZEN', 'That target is already cancelled.');
        }
        await repo.cancelTarget(tx, context.orgId, id, context.userId);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.target.cancelled',
          entityType: 'Target',
          entityId: id,
          before: { status: row.status },
          after: { status: 'cancelled' },
          requestId: context.requestId,
          request,
        });
        const fresh = await repo.targetById(tx, context.orgId, id);
        const [view] = await this.views(tx, context.orgId, fresh === undefined ? [] : [fresh]);
        if (view === undefined) throw new Error('a target vanished inside its own transaction');
        return view;
      }),
    );
  }

  /** `POST /targets/refresh`: recompute now rather than wait for the next order event. */
  async refresh(context: ActiveContext, request: AuditableRequest): Promise<{ updated: number }> {
    // Org-wide work behind an org-wide grant (`update Target`, hr and org_admin only).
    assertInScope(request, { branchId: null, createdBy: context.userId });
    const updated = await this.refreshOrg(context.orgId, context.userId);
    await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'hr.target.refreshed',
        entityType: 'Target',
        entityId: context.orgId,
        before: null,
        after: { updated },
        requestId: context.requestId,
        request,
      }),
    );
    return { updated };
  }

  // --- progress ----------------------------------------------------------------

  /**
   * Recompute every active target of this month and last month (D-279).
   *
   * Last month too, because a parcel confirmed on the 30th is usually delivered in the
   * next month's first week, and a delivered-orders target for the month it was confirmed
   * in does not care — it counts by delivery date, so last month's figure can still move
   * until its deliveries stop. Returns how many targets moved.
   */
  async refreshOrg(
    orgId: string,
    userId: string = PROGRESS_ACTOR,
    now = new Date(),
  ): Promise<number> {
    return withOrg({ orgId, userId }, async (tx) => {
      const month = currentMonth(now);
      const targets = await repo.activeTargets(tx, orgId, [addMonths(month, -1), month]);
      return this.applyProgress(tx, orgId, targets);
    });
  }

  /**
   * Each target's progress, computed and not written: the rollup, the bonus preview and
   * the payroll apply all read this one function.
   */
  async progressOf(
    tx: Tx,
    orgId: string,
    targets: readonly repo.TargetRow[],
  ): Promise<Map<string, Progress>> {
    const result = new Map<string, Progress>();
    if (targets.length === 0) return result;

    const months = [...new Set(targets.map((target) => target.month))].sort();
    const from = `${months[0] ?? ''}-01`;
    const to = lastDay(months[months.length - 1] ?? '');
    const results = await this.orders.agentResults(tx, orgId, { from, to });
    const members = await repo.membersOf(
      tx,
      orgId,
      targets.map((target) => target.id),
    );
    const weeks = await repo.weeksOf(
      tx,
      orgId,
      targets.map((target) => target.id),
    );

    for (const target of targets) {
      result.set(
        target.id,
        rollupProgress({
          metric: target.metric as TargetMetric,
          targetValue: BigInt(target.target_value),
          weeks: weeks
            .filter((week) => week.target_id === target.id)
            .map((week) => ({
              weekNo: week.week_no,
              startsOn: toIsoDate(week.starts_on),
              endsOn: toIsoDate(week.ends_on),
            })),
          memberUserIds: members
            .filter((member) => member.target_id === target.id && member.user_id !== null)
            .map((member) => member.user_id ?? ''),
          results: results.map((one) => ({ ...one, businessDate: toIsoDate(one.businessDate) })),
        }),
      );
    }
    return result;
  }

  /** Write the progress that moved, and tell the members and HR (§19). */
  private async applyProgress(
    tx: Tx,
    orgId: string,
    targets: readonly repo.TargetRow[],
  ): Promise<number> {
    const progress = await this.progressOf(tx, orgId, targets);
    const weeks = await repo.weeksOf(
      tx,
      orgId,
      targets.map((target) => target.id),
    );
    const members = await repo.membersOf(
      tx,
      orgId,
      targets.map((target) => target.id),
    );

    let moved = 0;
    for (const target of targets) {
      const next = progress.get(target.id);
      if (next === undefined) continue;
      const stored = weeks.filter((week) => week.target_id === target.id);
      const weekMoved = next.weeks.some(
        (week) =>
          stored.find((one) => one.week_no === week.weekNo)?.achieved !== week.achieved.toString(),
      );
      if (
        next.achieved.toString() === target.achieved &&
        !weekMoved &&
        target.progress_at !== null
      ) {
        continue;
      }

      await repo.setTargetAchieved(tx, orgId, target.id, next.achieved);
      for (const week of next.weeks) {
        await repo.setWeekAchieved(tx, orgId, target.id, week.weekNo, week.achieved);
      }
      if (next.achieved.toString() !== target.achieved) {
        moved += 1;
        await emit(
          tx,
          'target.progress',
          {
            targetId: target.id,
            achieved: next.achieved.toString(),
            pctBps: next.pctBps,
            userIds: members
              .filter((member) => member.target_id === target.id && member.user_id !== null)
              .map((member) => member.user_id ?? '')
              .slice(0, 50),
          },
          { orgId },
        );
      }
    }
    return moved;
  }

  private async calendar(
    tx: Tx,
    orgId: string,
    calendarId: string,
    month: PayrollMonth,
  ): Promise<WorkCalendar> {
    const row = await hrRepo.calendarById(tx, orgId, calendarId);
    if (row === undefined) throw new HrError('HR_NOT_FOUND', 'No such working-day calendar.');
    const holidays = await hrRepo.holidaysBetween(
      tx,
      orgId,
      calendarId,
      `${month}-01`,
      lastDay(month),
    );
    return { weeklyOff: row.weekly_off, holidays: holidays.map((date) => toIsoDate(date)) };
  }

  // --- the agent's own dashboard ----------------------------------------------

  /**
   * `GET /performance/me`: the caller's targets for a month and their own desk figures.
   *
   * Only ever the caller's: the targets query is limited to targets that count them on top
   * of the route's scope, and productivity is computed for their login alone.
   */
  async me(
    context: ActiveContext,
    request: object,
    month: string | undefined,
  ): Promise<{
    month: string;
    employee: { id: string; code: string; name: string } | null;
    targets: TargetView[];
    productivity: Omit<
      ProductivityRow,
      'employeeId' | 'employeeCode' | 'employeeName' | 'branchId'
    > | null;
  }> {
    const chosen = month ?? currentMonth();
    const scope = this.targetScope(request, context.userId);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const employee = await hrRepo.employeeByUser(tx, context.orgId, context.userId);
      const rows = await repo.listTargets(tx, context.orgId, {
        scope,
        month: chosen,
        status: 'active',
        memberUserId: context.userId,
      });
      const from = dhakaMidnight(`${chosen}-01`);
      const to = dhakaMidnight(addDays(toIsoDate(lastDay(chosen)), 1));
      const mine = (await this.agentFigures(tx, context.orgId, from, to)).find(
        (row) => row.agent === context.userId,
      );
      return {
        month: chosen,
        employee:
          employee === undefined
            ? null
            : { id: employee.id, code: employee.code, name: employee.full_name },
        targets: await this.views(tx, context.orgId, rows),
        productivity:
          mine === undefined
            ? {
                pickups: 0,
                medianPickupSeconds: null,
                p90PickupSeconds: null,
                handledOrders: 0,
                activeHours: 0,
                ordersPerActiveHour: null,
              }
            : withoutAgent(mine),
      };
    });
  }

  // --- productivity ---------------------------------------------------------------

  /**
   * `GET /productivity`: one row per employee with a login, inside the caller's scope.
   *
   * The scope is applied to the employee rows — `branchId` is the employee's branch and
   * `own` is the employee whose login is the caller's — so an agent's report has exactly
   * one row in it, and a branch manager's has their branch's staff.
   */
  async productivity(
    context: ActiveContext,
    request: object,
    query: ProductivityQuery,
  ): Promise<{ from: string; to: string; items: ProductivityRow[] }> {
    const scope = scopeWhere(request, {
      branchId: sql`e.branch_id`,
      assignedTo: sql`e.user_id`,
      createdBy: sql`e.user_id`,
    });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const staff = await repo.staffWithLogins(tx, context.orgId, scope);
      const from = dhakaMidnight(query.from);
      const to = dhakaMidnight(addDays(toIsoDate(query.to), 1));
      const figures = new Map(
        (await this.agentFigures(tx, context.orgId, from, to)).map((row) => [row.agent, row]),
      );
      return {
        from: query.from,
        to: query.to,
        items: staff.map((person) => {
          const found = figures.get(person.user_id);
          return {
            employeeId: person.id,
            employeeCode: person.code,
            employeeName: person.full_name,
            branchId: person.branch_id,
            ...(found === undefined
              ? {
                  pickups: 0,
                  medianPickupSeconds: null,
                  p90PickupSeconds: null,
                  handledOrders: 0,
                  activeHours: 0,
                  ordersPerActiveHour: null,
                }
              : withoutAgent(found)),
          };
        }),
      };
    });
  }

  private async agentFigures(
    tx: Tx,
    orgId: string,
    from: Date,
    to: Date,
  ): Promise<AgentProductivity[]> {
    const rows = await repo.deskEventsTouching(tx, orgId, from, to);
    const events: DeskEvent[] = rows.map((row) => ({
      eventId: row.event_id,
      orderId: row.order_id,
      kind: row.kind as DeskEventKind,
      at: row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
      assignee: row.assignee_user_id,
      actor: row.actor_user_id,
    }));
    return productivity(events, { from, to });
  }

  // --- the outbox subscriber's half ---------------------------------------------

  /**
   * Record one order event as a desk fact; say whether targets may have moved.
   *
   * Called by the worker's outbox subscriber, at least once per event (§19): the insert is
   * keyed by the outbox row's id, so a redelivery writes nothing.
   */
  async recordDeskEvent(event: DeliveredEvent): Promise<{ refresh: boolean }> {
    const payload = (event.payload ?? {}) as {
      id?: unknown;
      assignedTo?: unknown;
      to?: unknown;
    };
    if (typeof payload.id !== 'string') return { refresh: false };
    const desk = deskEventFrom(event.name, {
      id: payload.id,
      assignedTo: typeof payload.assignedTo === 'string' ? payload.assignedTo : null,
      ...(typeof payload.to === 'string' ? { to: payload.to } : {}),
    });
    if (desk !== null) {
      await withOrg({ orgId: event.orgId, userId: PROGRESS_ACTOR }, (tx) =>
        repo.insertDeskEvent(tx, {
          orgId: event.orgId,
          eventId: event.id,
          orderId: desk.orderId,
          kind: desk.kind,
          assigneeUserId: desk.assignee,
          actorUserId: event.actorUserId,
          occurredAt: event.occurredAt,
        }),
      );
    }
    return {
      refresh:
        event.name === 'order.status_changed' &&
        typeof payload.to === 'string' &&
        movesTargets(payload.to),
    };
  }
}

function withoutAgent(row: AgentProductivity) {
  return {
    pickups: row.pickups,
    medianPickupSeconds: row.medianPickupSeconds,
    p90PickupSeconds: row.p90PickupSeconds,
    handledOrders: row.handledOrders,
    activeHours: row.activeHours,
    ordersPerActiveHour: row.ordersPerActiveHour,
  };
}
