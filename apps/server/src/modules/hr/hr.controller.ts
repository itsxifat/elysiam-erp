import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { AttendanceService } from './attendance.service.js';
import { EmployeesService } from './employees.service.js';
import { LoansService } from './loans.service.js';
import { PayrollService } from './payroll.service.js';
import { PayslipService } from './payslip.service.js';
import { mapHrErrors } from './hr.errors.js';
import {
  attendanceImportSchema,
  attendanceQuerySchema,
  calendarSchema,
  createEmployeeSchema,
  createLoanSchema,
  createRunSchema,
  disburseLoanSchema,
  employeeQuerySchema,
  holidaySchema,
  hrIdSchema,
  loanQuerySchema,
  payRunSchema,
  recordAttendanceSchema,
  runInputSchema,
  runQuerySchema,
  salaryStructureSchema,
  submitRunSchema,
  updateEmployeeSchema,
} from './hr.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * The Fastify request as the audit net sees it.
 *
 * `AuditableRequest` is an index-signature type — the interceptor stashes its bookkeeping
 * on the request object — and `FastifyRequest` has no index signature, so the cast is
 * structural rather than a widening. Same helper the wallets and inventory controllers
 * declare, for the same reason.
 */
const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * HR and payroll over HTTP (architecture §6, §12, §23).
 *
 * Every route declares an ability, and the split is §6's two rows exactly — which are two
 * rows and not one, because collapsing them is the mistake `subjects.ts` warns about:
 *
 * * **`Employee`** — the people. hr and org_admin org-wide, branch_manager for their own
 *   branch's staff, accounts read-only, and everybody else `own`: their own record, their
 *   own attendance, their own payslip. That last grant is why the payslip route declares
 *   `read Employee` rather than `read Payroll` — an employee has to be able to read their
 *   own, and `PayslipService` then requires either `read Payroll` or that it is theirs.
 * * **`Payroll`** — the money. hr creates and runs it, accounts posts and pays it
 *   (`update`), org_admin does both. Nobody else holds it at all, so no other role can
 *   list a run, read a total or see another person's payslip.
 *
 * **There is no route that sets a payroll run's status directly**, for anybody. A run is
 * submitted, approved through `POST /v1/approvals/:id/decide`, and paid — and the posting
 * happens inside the approving transaction. An endpoint that set `posted` would be a way
 * to book a month's salary with no second person, and migration 0055 refuses it; the route
 * not existing is what stops a client trying.
 *
 * Salary amounts are not in `COST_FIELDS` and are not stripped by `serializeFor`: they are
 * protected by the `Payroll` grant instead, because a payslip whose amounts were removed
 * would be a payslip. `SerializeInterceptor` still runs on every response here, and the
 * employee views carry masks rather than plaintexts regardless (invariant 10).
 */
@Controller('v1/hr')
export class HrController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly attendance: AttendanceService,
    private readonly payroll: PayrollService,
    private readonly loans: LoansService,
    private readonly payslips: PayslipService,
  ) {}

  // --- employees --------------------------------------------------------------

  @RequireAbility('read', 'Employee')
  @Get('employees')
  async listEmployees(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(employeeQuerySchema, query ?? {});
    return this.employees.list(requireContext(request), request, parsed);
  }

  /**
   * The employee form's branch picker (D-419): `create Employee`, the grant the form needs,
   * scoped like the add itself. Id, code and name only.
   */
  @RequireAbility('create', 'Employee')
  @Get('branch-options')
  async branchOptions(@Req() request: FastifyRequest) {
    return this.employees.branchOptions(requireContext(request), request);
  }

  /**
   * The sign-ins an employee may be linked to (D-419): `update Payroll`, which linking needs
   * (D-363). Names, masked emails, roles and the existing link; nothing about the sign-in.
   */
  @RequireAbility('update', 'Payroll')
  @Get('login-options')
  async loginOptions(@Req() request: FastifyRequest) {
    return this.employees.loginOptions(requireContext(request));
  }

  @RequireAbility('read', 'Employee')
  @Get('employees/:id')
  async getEmployee(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.employees.get(requireContext(request), request, parse(hrIdSchema, id));
  }

  @RequireAbility('create', 'Employee')
  @Post('employees')
  async createEmployee(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createEmployeeSchema, body);
    return this.employees.create(requireContext(request), auditable(request), input);
  }

  @RequireAbility('update', 'Employee')
  @Patch('employees/:id')
  async updateEmployee(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(updateEmployeeSchema, body);
    return this.employees.update(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input,
    );
  }

  /**
   * The payout account number in the clear.
   *
   * `update Payroll`, not `read Employee`. §6's matrix gives `update Payroll` to accounts, hr
   * and org_admin at org scope — and *not* to a branch manager, who holds `update Employee`
   * for their branch and no Payroll grant at all. That is the line that matters here: the
   * staff records a showroom manager can edit are records whose bank details they cannot
   * read. Keying this off `read Employee` would give it to every role at `own` scope and to
   * every branch manager for their branch.
   *
   * Audited on every call (`hr.employee.payout_ref.revealed`), because who looked at
   * somebody's bank details is exactly what an audit log is for.
   */
  @RequireAbility('update', 'Payroll')
  @Get('employees/:id/payout-ref')
  async payoutRef(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.employees.revealPayoutRef(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
    );
  }

  // --- salary structures ------------------------------------------------------

  @RequireAbility('read', 'Payroll')
  @Get('employees/:id/salary')
  async structures(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.employees.structures(requireContext(request), request, parse(hrIdSchema, id));
  }

  /**
   * A new version of somebody's salary.
   *
   * `create Payroll` — hr and org_admin. Not `update Employee`: a salary is money, and §6
   * gives branch managers their branch's staff records without giving them the power to
   * set what those staff are paid.
   *
   * A POST rather than a PUT, and never an edit of the existing row: §12 versions a
   * structure by effective date so that June's raise does not restate May's payslip, and
   * migration 0055 refuses a change to a structure a payslip has used.
   */
  @RequireAbility('create', 'Payroll')
  @Post('employees/:id/salary')
  async setStructure(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(salaryStructureSchema, body);
    return this.employees.setStructure(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input,
    );
  }

  // --- working-day calendars --------------------------------------------------

  /**
   * `read Employee`, and the scope is declared to have no row dimension.
   *
   * A working-day calendar is org configuration — it is what a month's salary is divided
   * across — with no branch and no owner, so there is nothing for a `branch` or an `own`
   * filter to narrow. A route that simply ignored the filter would be refused by
   * `ScopeInterceptor` as a 500 for every scoped caller, which is that backstop working;
   * `scopeHasNoRowDimension` is how a handler says "there are no rows here to scope" out
   * loud instead of routing around it.
   *
   * Kept on `read Employee` rather than narrowed to `read Payroll` so a branch manager, who
   * records their own floor's attendance, can see which days the org counts as working days.
   */
  @RequireAbility('read', 'Employee')
  @Get('calendars')
  async calendars(@Req() request: FastifyRequest) {
    return this.employees.calendars(requireContext(request), request);
  }

  @RequireAbility('create', 'Payroll')
  @Post('calendars')
  async createCalendar(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(calendarSchema, body);
    return this.employees.createCalendar(requireContext(request), auditable(request), input);
  }

  @RequireAbility('create', 'Payroll')
  @Post('calendars/:id/holidays')
  async addHoliday(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(holidaySchema, body);
    return this.employees.addHoliday(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input,
    );
  }

  // --- attendance -------------------------------------------------------------

  @RequireAbility('read', 'Employee')
  @Get('attendance')
  async listAttendance(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(attendanceQuerySchema, query ?? {});
    return this.attendance.list(requireContext(request), request, parsed);
  }

  /**
   * `update Employee`, not `update Payroll`.
   *
   * Attendance is a staff record, and §6's employees row gives branch managers their own
   * branch's staff — which is exactly who marks a showroom's attendance. Keying it off
   * the payroll grant would mean only hr and accounts could record a day, and a showroom
   * manager would be emailing absences to head office.
   */
  @RequireAbility('update', 'Employee')
  @Put('attendance')
  async recordAttendance(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(recordAttendanceSchema, body);
    return this.attendance.record(requireContext(request), auditable(request), input);
  }

  /** `read Payroll`, for the same reason the calendars list is: an import is not a row about
   * one person, so there is nothing for a `branch` or `own` filter to narrow. A branch manager
   * keeps `update Employee` and therefore keeps importing; what they read back is the
   * attendance list, which *is* branch-scoped. */
  @RequireAbility('read', 'Payroll')
  @Get('attendance/imports')
  async imports(@Req() request: FastifyRequest, @Query('month') month?: string) {
    return this.attendance.imports(requireContext(request), month);
  }

  /**
   * Parse a biometric CSV, and apply it only when asked.
   *
   * `update Employee` for the same reason as the manual entry above. `apply` defaults to
   * false, so the first call is a preview: a wrong column mapping would otherwise mark a
   * month of absences on the first click.
   */
  @RequireAbility('update', 'Employee')
  @Post('attendance/imports')
  async importAttendance(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(attendanceImportSchema, body);
    return this.attendance.import(requireContext(request), auditable(request), input);
  }

  // --- payroll runs -----------------------------------------------------------

  /**
   * The wallets a run or a staff loan may be paid from: id and name only (D-396).
   *
   * `update Payroll`, the grant `pay` and `disburse` declare, so whoever may press Pay can
   * load its picker — hr included, who holds no `read Wallet` and so could not load
   * `GET /v1/ledger/wallets`. No balance leaves here.
   */
  @RequireAbility('update', 'Payroll')
  @Get('payroll/wallets')
  async payableWallets(@Req() request: FastifyRequest) {
    return this.payroll.payableWallets(requireContext(request));
  }

  @RequireAbility('read', 'Payroll')
  @Get('payroll/runs')
  async listRuns(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.payroll.listRuns(requireContext(request), parse(runQuerySchema, query ?? {}));
  }

  @RequireAbility('read', 'Payroll')
  @Get('payroll/runs/:id')
  async getRun(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.payroll.getRun(requireContext(request), parse(hrIdSchema, id));
  }

  @RequireAbility('create', 'Payroll')
  @Post('payroll/runs')
  async createRun(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createRunSchema, body);
    return this.payroll.createRun(requireContext(request), auditable(request), input);
  }

  /** What the run would pay, from today's data. Read-only; nothing is stored. */
  @RequireAbility('read', 'Payroll')
  @Get('payroll/runs/:id/preview')
  async preview(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.payroll.preview(requireContext(request), parse(hrIdSchema, id));
  }

  @RequireAbility('read', 'Payroll')
  @Get('payroll/runs/:id/inputs')
  async listInputs(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.payroll.listInputs(requireContext(request), parse(hrIdSchema, id));
  }

  @RequireAbility('create', 'Payroll')
  @Post('payroll/runs/:id/inputs')
  async addInput(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(runInputSchema, body);
    return this.payroll.addInput(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input,
    );
  }

  @RequireAbility('create', 'Payroll')
  @Delete('payroll/runs/:id/inputs/:inputId')
  async removeInput(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('inputId') inputId: string,
  ) {
    return this.payroll.removeInput(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      parse(hrIdSchema, inputId),
    );
  }

  /**
   * Freeze the payslips and send the run to a checker.
   *
   * `create Payroll` — hr and org_admin, which matches `REQUESTER_TYPES.hr` (D-072:
   * `payroll_run` and `bonus_rule`). Nothing is posted here, and that is the point: the
   * run comes back `pending_approval` with a journal of null.
   */
  @RequireAbility('create', 'Payroll')
  @Post('payroll/runs/:id/submit')
  async submit(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(submitRunSchema, body ?? {});
    return this.payroll.submit(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input,
    );
  }

  @RequireAbility('create', 'Payroll')
  @Post('payroll/runs/:id/cancel')
  async cancel(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.payroll.cancel(requireContext(request), auditable(request), parse(hrIdSchema, id));
  }

  /**
   * Pay a posted run out of a wallet.
   *
   * `update Payroll` — accounts, hr and org_admin, which is what §6's matrix actually grants
   * (`hr|update|Payroll|org`). So this is **not** a segregation of duties between preparing
   * and paying: the separation this design enforces is maker from checker on the *run*, which
   * the approval does, and the amount paid is the amount that was approved and posted with no
   * field on the request that could say otherwise (D-078).
   *
   * Splitting "prepares the payroll" from "moves the cash" would need a subject the matrix
   * does not have; recorded as a follow-up rather than invented here, because §6 is the
   * design and a route that narrowed it would be a second, quieter matrix.
   */
  @RequireAbility('update', 'Payroll')
  @Post('payroll/runs/:id/pay')
  async pay(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(payRunSchema, body);
    return this.payroll.pay(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input,
    );
  }

  // --- payslips ---------------------------------------------------------------

  @RequireAbility('read', 'Payroll')
  @Get('payroll/runs/:id/payslips')
  async payslipList(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.payroll.payslips(requireContext(request), parse(hrIdSchema, id));
  }

  /**
   * One payslip as a Bangla PDF.
   *
   * **`read Employee`**, which every staff role holds at least at `own` scope — because an
   * employee has to be able to read their own payslip, and `read Payroll` is held by hr,
   * accounts and org_admin alone. The row-level decision is `PayslipService.authorize`:
   * `read Payroll`, or it is the caller's own employee record, and anything else is a 404.
   * That is the same two-level arrangement `files.policy.ts` describes — a coarse grant
   * opens the endpoint, the document's subject decides the row (D-115).
   *
   * `@Res({ passthrough: false })` and a manual send, because this returns bytes rather
   * than JSON and the serializer would otherwise try to walk a PDF.
   */
  @RequireAbility('read', 'Employee')
  @Get('payroll/runs/:id/payslips/:employeeId/pdf')
  async payslipPdf(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
    @Res() reply: FastifyReply,
  ) {
    const { pdf, filename } = await mapHrErrors(() =>
      this.payslips.render(
        requireContext(request),
        request,
        parse(hrIdSchema, id),
        parse(hrIdSchema, employeeId),
      ),
    );
    await reply
      .header('content-type', 'application/pdf')
      // `attachment`, not `inline`: a payslip is a document somebody keeps, and an
      // inline render in a browser tab is one back-button press from being lost.
      .header('content-disposition', `attachment; filename="${filename}"`)
      // Never cached by a proxy. It is one person's salary.
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(pdf));
  }

  // --- loans ------------------------------------------------------------------

  @RequireAbility('read', 'Payroll')
  @Get('loans')
  async listLoans(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(loanQuerySchema, query ?? {});
    return this.loans.list(requireContext(request), request, parsed);
  }

  @RequireAbility('read', 'Payroll')
  @Get('loans/:id')
  async getLoan(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.loans.get(requireContext(request), request, parse(hrIdSchema, id));
  }

  @RequireAbility('create', 'Payroll')
  @Post('loans')
  async createLoan(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createLoanSchema, body);
    return this.loans.create(requireContext(request), auditable(request), input);
  }

  /**
   * `update Payroll` — accounts, hr and org_admin.
   *
   * No approval row, but two people (M30, D-363): the person who recorded the loan cannot pay
   * it out, and nobody pays out a loan to themselves (`PAYROLL_SELF_DEALING`, in
   * `LoansService.disburse`). A threshold-based approval type would be §6's to add.
   */
  @RequireAbility('update', 'Payroll')
  @Post('loans/:id/disburse')
  async disburseLoan(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(disburseLoanSchema, body);
    return this.loans.disburse(
      requireContext(request),
      auditable(request),
      parse(hrIdSchema, id),
      input,
    );
  }
}
