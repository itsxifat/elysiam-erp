import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeHasNoRowDimension, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  HR_CRYPTO,
  HrCrypto,
  maskEmployeePhone,
  maskNationalId,
  maskPayoutRef,
  type HrEncryptedField,
} from './hr.crypto.js';
import { HrError, mapHrErrors } from './hr.errors.js';
import * as repo from './hr.repository.js';
import type {
  CalendarInput,
  CreateEmployeeInput,
  EmployeeQuery,
  HolidayInput,
  SalaryStructureInput,
  UpdateEmployeeInput,
} from './hr.schemas.js';

/**
 * Employees, their salary structures and the org's working-day calendars
 * (architecture §12; §6's employees row).
 *
 * ## What never leaves this service
 *
 * A national ID number, a bank account number and a phone number go in once and come
 * back only as masks. `EmployeeView` has no field that could hold a plaintext, which
 * is deliberate rather than incidental: a `nationalId?: string` on the view would be
 * dropped by `serializeFor` only if somebody remembered to add it to a field list, and
 * invariant 10 is not a thing to enforce by remembering. The one exception is
 * `payoutRef` on `revealPayoutRef`, which exists because accounts has to read the
 * number to make a bank transfer — it is a separate call, on a separate ability, and
 * it writes its own audit row saying who looked.
 *
 * ## Why the audit rows carry salary and not identity
 *
 * `AuditService.record` redacts anything whose field name matches `nid`, `kyc`,
 * `bkash`, `account_number` and a dozen others (`REDACTED_FIELD_PATTERNS`), and masks
 * phone numbers. Salary amounts are not in that list and are recorded in full, because
 * "who changed Rina's basic from ৳18,000 to ৳30,000, and when" is the single most
 * important question the audit log answers about payroll. The log itself is behind
 * `read AuditLog`, which §6 gives org_admin alone.
 */

export interface EmployeeView {
  readonly id: string;
  readonly code: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly department: string | null;
  readonly branchId: string | null;
  readonly userId: string | null;
  readonly joinDate: string;
  readonly leaveDate: string | null;
  readonly status: string;
  readonly calendarId: string | null;
  readonly payoutMethod: string;
  /** Masks only. The plain values are encrypted at rest (invariant 10, check 3). */
  readonly payoutRefMasked: string | null;
  readonly nationalIdMasked: string | null;
  readonly phoneMasked: string | null;
}

export interface SalaryStructureView {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveFrom: string;
  readonly basicPoisha: string;
  readonly note: string | null;
  readonly components: readonly {
    readonly direction: string;
    readonly code: string;
    readonly label: string;
    readonly amountPoisha: string;
    readonly prorated: boolean;
  }[];
}

export interface CalendarView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly weeklyOff: readonly number[];
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly holidays: readonly { readonly date: string; readonly label: string }[];
}

@Injectable()
export class EmployeesService {
  constructor(
    @Inject(HR_CRYPTO) private readonly crypto: HrCrypto,
    private readonly audit: AuditService,
  ) {}

  /** The scope columns for an employee row, mapped once (§6 `own` and `branch`). */
  private employeeScope(request: object) {
    return scopeWhere(request, {
      branchId: sql`e.branch_id`,
      createdBy: sql`e.created_by`,
      /*
       * `own` means "my own employee record".
       *
       * §6 gives sales, marketing and warehouse `read Employee` at `own` scope, and
       * the only reading of that anybody meant is "the row about me". `user_id` is
       * therefore the `assignedTo` column; `created_by` is mapped too, because
       * `own` produces both conditions and an unmapped one is an exception rather
       * than a narrower filter.
       */
      assignedTo: sql`e.user_id`,
    });
  }

  async list(
    context: ActiveContext,
    request: object,
    query: EmployeeQuery,
  ): Promise<{ items: EmployeeView[]; page: number; pageSize: number }> {
    const scope = this.employeeScope(request);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listEmployees(tx, context.orgId, {
        scope,
        q: query.q,
        branchId: query.branchId,
        status: query.status,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      });
      return { items: rows.map(view), page: query.page, pageSize: query.pageSize };
    });
  }

  async get(context: ActiveContext, request: object, id: string): Promise<EmployeeView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        view(await this.scoped(tx, context, request, id)),
      ),
    );
  }

  /**
   * One employee, checked against the caller's row scope.
   *
   * `assertInScope` rather than a WHERE clause, because it answers 404 for a row
   * outside the scope: a row somebody may not see should be indistinguishable from one
   * that does not exist, or the error is an existence oracle for the staff list.
   */
  private async scoped(
    tx: Tx,
    context: ActiveContext,
    request: object,
    id: string,
  ): Promise<repo.EmployeeRow> {
    const row = await repo.employeeById(tx, context.orgId, id);
    if (row === undefined) throw new HrError('HR_NOT_FOUND', 'No such employee in this brand.');
    assertInScope(request, {
      branchId: row.branch_id,
      createdBy: row.created_by,
      assignedTo: row.user_id,
    });
    return row;
  }

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateEmployeeInput,
  ): Promise<EmployeeView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // A branch manager may only add staff to their own branch. Asserted on the
        // row about to be inserted, which is what `ScopeInterceptor` requires of a
        // create (D-061).
        assertInScope(request, { branchId: input.branchId ?? null });

        /*
         * The id is generated before the insert, because the AAD binds each
         * ciphertext to the employee it belongs to (`hr.crypto.ts`) and the id is part
         * of the AAD. Encrypting after the insert would need a second UPDATE and would
         * leave a window in which the row exists with no payout details — which the
         * `employees_payout_ref_present` CHECK would refuse anyway.
         */
        const id = await newId(tx);
        const owner = { orgId: context.orgId, employeeId: id };

        const secrets = this.sealAll(owner, input);
        await tx.execute(sql`
          insert into hr.employees
            (id, org_id, branch_id, user_id, code, full_name, designation, department,
             join_date, calendar_id, payout_method, payout_ref_cipher, payout_ref_masked,
             national_id_cipher, national_id_masked, phone_cipher, phone_masked, created_by)
          values (
            ${id}, ${context.orgId}, ${input.branchId ?? null}::uuid, ${input.userId ?? null},
            ${input.code}, ${input.fullName}, ${input.designation ?? null},
            ${input.department ?? null}, ${input.joinDate}::date,
            ${input.calendarId ?? null}::uuid, ${input.payoutMethod}::hr.payout_method,
            ${secrets.payoutRefCipher}, ${secrets.payoutRefMasked},
            ${secrets.nationalIdCipher}, ${secrets.nationalIdMasked},
            ${secrets.phoneCipher}, ${secrets.phoneMasked}, ${context.userId}
          )
        `);

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.employee.created',
          entityType: 'Employee',
          entityId: id,
          before: null,
          // Masks, not plaintexts. `AuditService.record` would redact a field named
          // `nationalId` anyway, but a field named `payoutRef` it would not — and the
          // audit log is append-only, so a plaintext written here is a plaintext
          // forever.
          after: {
            code: input.code,
            fullName: input.fullName,
            branchId: input.branchId ?? null,
            joinDate: input.joinDate,
            payoutMethod: input.payoutMethod,
            payoutRefMasked: secrets.payoutRefMasked,
            nationalIdMasked: secrets.nationalIdMasked,
            phoneMasked: secrets.phoneMasked,
          },
          requestId: context.requestId,
          request,
        });

        const row = await repo.employeeById(tx, context.orgId, id);
        if (row === undefined) throw new HrError('HR_NOT_FOUND', 'No such employee.');
        return view(row);
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: UpdateEmployeeInput,
  ): Promise<EmployeeView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await this.scoped(tx, context, request, id);
        // Moving somebody to another branch is moving them out of one manager's scope
        // and into another's, so the destination is checked as well as the source.
        if (input.branchId !== undefined) {
          assertInScope(request, { branchId: input.branchId });
        }

        const owner = { orgId: context.orgId, employeeId: id };
        const secrets = this.sealAll(owner, input);

        await repo.updateEmployee(tx, context.orgId, id, {
          fullName: input.fullName,
          userId: input.userId,
          designation: input.designation,
          department: input.department,
          branchId: input.branchId,
          calendarId: input.calendarId,
          status: input.status,
          /*
           * A resignation dates itself.
           *
           * Without a leave date the proration has no idea the person stopped working
           * (`attendanceSummary` prorates by the employment window), so they would be
           * paid a full month for the month they left. Defaulted to today rather than
           * refused, because the common case is HR marking somebody resigned on the
           * day it happens and a required field there is a field somebody guesses.
           */
          leaveDate:
            input.leaveDate !== undefined
              ? input.leaveDate
              : input.status === 'resigned' || input.status === 'terminated'
                ? (before.leave_date ?? today())
                : undefined,
          payoutMethod: input.payoutMethod,
          ...(secrets.payoutRefCipher === null
            ? {}
            : {
                payoutRefCipher: secrets.payoutRefCipher,
                payoutRefMasked: secrets.payoutRefMasked ?? undefined,
              }),
          ...(secrets.nationalIdCipher === null
            ? {}
            : {
                nationalIdCipher: secrets.nationalIdCipher,
                nationalIdMasked: secrets.nationalIdMasked ?? undefined,
              }),
          ...(secrets.phoneCipher === null
            ? {}
            : {
                phoneCipher: secrets.phoneCipher,
                phoneMasked: secrets.phoneMasked ?? undefined,
              }),
        });

        const after = await repo.employeeById(tx, context.orgId, id);
        if (after === undefined) throw new HrError('HR_NOT_FOUND', 'No such employee.');

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.employee.updated',
          entityType: 'Employee',
          entityId: id,
          before: auditable(before),
          after: auditable(after),
          requestId: context.requestId,
          request,
        });

        return view(after);
      }),
    );
  }

  /**
   * The payout account number in the clear, for the person making the transfer.
   *
   * A separate call on its own audit action, because it is the one read in this module
   * that hands over personal data. The alternative — putting the number on the
   * employee view for roles that hold `read Payroll` — would send it in every list
   * response accounts ever loads, into every browser cache and every HAR file, to
   * answer a question somebody asks twice a month.
   *
   * Never returns the national ID. Nothing in the system needs it back: it is stored
   * because §12 asks for KYC on file, and if it is ever needed the KYC document itself
   * is in the private bucket behind `read Employee` (`files.policy.ts`).
   */
  async revealPayoutRef(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
  ): Promise<{ payoutMethod: string; payoutRef: string | null }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const employee = await this.scoped(tx, context, request, id);
        const secrets = await repo.employeeSecrets(tx, context.orgId, id);
        const cipher = secrets?.payout_ref_cipher ?? null;

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          /*
           * Recorded even though nothing changed: who looked at somebody's bank
           * details is exactly what an audit log is for.
           *
           * `update` because `audit.audit_operation` has no `read` — the enum is
           * create/update/delete/approve/reject/login/logout. Adding one needs a
           * migration on a shared enum, which is a follow-up; the `action` string
           * says plainly what happened in the meantime, and it is the `action` that
           * anybody reading the log filters on.
           */
          operation: 'update',
          action: 'hr.employee.payout_ref.revealed',
          entityType: 'Employee',
          entityId: id,
          before: null,
          after: {
            payoutMethod: employee.payout_method,
            payoutRefMasked: employee.payout_ref_masked,
          },
          requestId: context.requestId,
          request,
        });

        return {
          payoutMethod: employee.payout_method,
          payoutRef:
            cipher === null
              ? null
              : this.crypto.decrypt(
                  Buffer.from(cipher),
                  { orgId: context.orgId, employeeId: id },
                  'payout_ref',
                ),
        };
      }),
    );
  }

  // --- salary structures ------------------------------------------------------

  async structures(
    context: ActiveContext,
    request: object,
    employeeId: string,
  ): Promise<{ items: SalaryStructureView[] }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.scoped(tx, context, request, employeeId);
        const rows = await repo.listStructures(tx, context.orgId, employeeId);
        const components = await repo.componentsFor(
          tx,
          context.orgId,
          rows.map((row) => row.id),
        );
        return { items: rows.map((row) => structureView(row, components)) };
      }),
    );
  }

  async setStructure(
    context: ActiveContext,
    request: AuditableRequest,
    employeeId: string,
    input: SalaryStructureInput,
  ): Promise<SalaryStructureView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        await this.scoped(tx, context, request, employeeId);

        const structureId = await repo.insertStructure(tx, {
          orgId: context.orgId,
          employeeId,
          effectiveFrom: input.effectiveFrom,
          basicPoisha: BigInt(input.basicPoisha),
          note: input.note ?? null,
          createdBy: context.userId,
        });

        for (const [index, component] of input.components.entries()) {
          await repo.insertComponent(tx, {
            orgId: context.orgId,
            structureId,
            direction: component.direction,
            code: component.code,
            label: component.label,
            amountPoisha: BigInt(component.amountPoisha),
            // Earnings prorate by default; deductions never do (D-029, see
            // `salary_components.prorated`).
            prorated: component.direction === 'earning' ? (component.prorated ?? true) : false,
            lineNo: index + 1,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.salary_structure.created',
          entityType: 'Payroll',
          entityId: structureId,
          before: null,
          after: {
            employeeId,
            effectiveFrom: input.effectiveFrom,
            basicPoisha: input.basicPoisha,
            components: input.components.map((component) => ({
              direction: component.direction,
              code: component.code,
              amountPoisha: component.amountPoisha,
            })),
          },
          requestId: context.requestId,
          request,
        });

        const rows = await repo.listStructures(tx, context.orgId, employeeId);
        const row = rows.find((candidate) => candidate.id === structureId);
        if (row === undefined) throw new HrError('HR_NOT_FOUND', 'No such salary structure.');
        const components = await repo.componentsFor(tx, context.orgId, [structureId]);
        return structureView(row, components);
      }),
    );
  }

  // --- working-day calendars --------------------------------------------------

  async calendars(context: ActiveContext, request: object): Promise<{ items: CalendarView[] }> {
    // A calendar has no branch and no owner, so there is nothing for a `branch` or `own`
    // filter to narrow. Said out loud rather than ignored: `ScopeInterceptor` refuses a
    // response a scoped caller's handler applied nothing to, and that refusal is correct.
    scopeHasNoRowDimension(
      request,
      'a working-day calendar is org configuration, not a row about a person',
    );
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      // The calendar screen is where somebody looks when payroll says a brand has none, so
      // it creates the default rather than showing an empty list (D-187).
      await repo.ensureDefaultCalendar(tx, context.orgId);
      const rows = await repo.listCalendars(tx, context.orgId);
      const items: CalendarView[] = [];
      for (const row of rows) {
        const holidays = await repo.listHolidays(tx, context.orgId, row.id);
        items.push({
          id: row.id,
          code: row.code,
          name: row.name,
          weeklyOff: row.weekly_off,
          isDefault: row.is_default,
          isActive: row.is_active,
          holidays: holidays.map((holiday) => ({
            date: holiday.holiday_date,
            label: holiday.label,
          })),
        });
      }
      return { items };
    });
  }

  async createCalendar(
    context: ActiveContext,
    request: AuditableRequest,
    input: CalendarInput,
  ): Promise<CalendarView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const id = await repo.insertCalendar(tx, {
          orgId: context.orgId,
          code: input.code,
          name: input.name,
          // De-duplicated and sorted, so `[5,5,6]` is `[5,6]`: the array reaches the
          // domain's `weeklyOff.includes` either way, but a duplicate would make two
          // calendars that behave identically look different in the UI.
          weeklyOff: [...new Set(input.weeklyOff)].sort((a, b) => a - b),
          isDefault: input.isDefault,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'hr.calendar.created',
          entityType: 'Payroll',
          entityId: id,
          before: null,
          after: { code: input.code, name: input.name, weeklyOff: input.weeklyOff },
          requestId: context.requestId,
          request,
        });

        return {
          id,
          code: input.code,
          name: input.name,
          weeklyOff: input.weeklyOff,
          isDefault: input.isDefault,
          isActive: true,
          holidays: [],
        };
      }),
    );
  }

  async addHoliday(
    context: ActiveContext,
    request: AuditableRequest,
    calendarId: string,
    input: HolidayInput,
  ): Promise<{ date: string; label: string }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const calendar = await repo.calendarById(tx, context.orgId, calendarId);
        if (calendar === undefined) {
          throw new HrError('HR_NOT_FOUND', 'No such working-day calendar in this brand.');
        }
        await repo.insertHoliday(tx, {
          orgId: context.orgId,
          calendarId,
          holidayDate: input.holidayDate,
          label: input.label,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.calendar.holiday_added',
          entityType: 'Payroll',
          entityId: calendarId,
          before: null,
          after: { holidayDate: input.holidayDate, label: input.label },
          requestId: context.requestId,
          request,
        });

        return { date: input.holidayDate, label: input.label };
      }),
    );
  }

  // --- encryption helpers -----------------------------------------------------

  private seal(
    owner: { orgId: string; employeeId: string },
    field: HrEncryptedField,
    plain: string | undefined,
    mask: (value: string) => string,
  ): { cipher: Buffer | null; masked: string | null } {
    if (plain === undefined) return { cipher: null, masked: null };
    return { cipher: this.crypto.encrypt(plain, owner, field), masked: mask(plain) };
  }

  private sealAll(
    owner: { orgId: string; employeeId: string },
    input: {
      payoutRef?: string | undefined;
      nationalId?: string | undefined;
      phone?: string | undefined;
    },
  ) {
    const payout = this.seal(owner, 'payout_ref', input.payoutRef, maskPayoutRef);
    const nid = this.seal(owner, 'national_id', input.nationalId, maskNationalId);
    const phone = this.seal(owner, 'phone', input.phone, maskEmployeePhone);
    return {
      payoutRefCipher: payout.cipher,
      payoutRefMasked: payout.masked,
      nationalIdCipher: nid.cipher,
      nationalIdMasked: nid.masked,
      phoneCipher: phone.cipher,
      phoneMasked: phone.masked,
    };
  }
}

/** A fresh employee id from the database, so the AAD can be built before the insert. */
async function newId(tx: Tx): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`select gen_random_uuid() as id`);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('generating an employee id returned nothing');
  return id;
}

/** Today as an Asia/Dhaka calendar date (invariant 8). */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function view(row: repo.EmployeeRow): EmployeeView {
  return {
    id: row.id,
    code: row.code,
    fullName: row.full_name,
    designation: row.designation,
    department: row.department,
    branchId: row.branch_id,
    userId: row.user_id,
    joinDate: row.join_date,
    leaveDate: row.leave_date,
    status: row.status,
    calendarId: row.calendar_id,
    payoutMethod: row.payout_method,
    payoutRefMasked: row.payout_ref_masked,
    nationalIdMasked: row.national_id_masked,
    phoneMasked: row.phone_masked,
  };
}

/** The subset of an employee row an audit entry records. Masks only. */
function auditable(row: repo.EmployeeRow): Record<string, unknown> {
  return {
    code: row.code,
    fullName: row.full_name,
    designation: row.designation,
    department: row.department,
    branchId: row.branch_id,
    status: row.status,
    leaveDate: row.leave_date,
    payoutMethod: row.payout_method,
    payoutRefMasked: row.payout_ref_masked,
    nationalIdMasked: row.national_id_masked,
    phoneMasked: row.phone_masked,
  };
}

function structureView(
  row: repo.StructureRow,
  components: readonly repo.ComponentRow[],
): SalaryStructureView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    effectiveFrom: row.effective_from,
    basicPoisha: row.basic_poisha,
    note: row.note,
    components: components
      .filter((component) => component.structure_id === row.id)
      .map((component) => ({
        direction: component.direction,
        code: component.code,
        label: component.label,
        amountPoisha: component.amount_poisha,
        prorated: component.prorated,
      })),
  };
}

/** Exported for the payroll service, which needs the same poisha coercion. */
export const toPoisha = (value: string | bigint) => poisha(BigInt(value));
