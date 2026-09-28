import { api, ApiError, CSRF_HEADER, csrfToken } from '../../api.js';
import { env } from '../../env.js';

/**
 * `/v1/hr/*`, typed to what the controller actually returns.
 *
 * Hand-written against the controller rather than taken from the generated client, for the
 * reason M06's catalog client gives: M04's generator types every operation's result as
 * `unknown`, and an `unknown` at the call site gets cast somewhere — a cast inside a page
 * component is a type nobody maintains.
 *
 * **Every amount is a string and every count is a number.** §23: integer poisha crosses the
 * wire as a decimal string, because `JSON.parse` turns a crore-scale value into a double and
 * loses its last digits. A brand's monthly salary bill is comfortably past that. `<Money>`
 * takes the string directly.
 *
 * **There is no plaintext personal field in any of these types**, and that is the point
 * rather than an omission. A national ID and a bank account number go *in* on a create and
 * come back only as `*Masked` (invariant 10). The one exception is `payoutRef` on
 * `revealPayoutRef`, which is a separate call behind `update Payroll` that the server audits
 * — so a screen that shows it is a screen somebody chose to open.
 */

async function send<T>(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  // The shared client exposes `get` and `post` only. Adding `put` and `delete` belongs in
  // that file, which is edited concurrently by other milestones in this working tree, so
  // M19's INTEGRATION section hands the integrator those methods and this helper disappears
  // with them. The two things it must not get wrong are the two the shared client exists
  // for: cookies cross-origin, and the CSRF token echoed as a header.
  const token = csrfToken();
  const response = await fetch(new URL(path, env.VITE_API_URL), {
    method,
    credentials: 'include',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === '' ? {} : { [CSRF_HEADER]: token }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const payload: unknown = text === '' ? null : safeParse(text);
  if (!response.ok) {
    const problem = (payload ?? {}) as { code?: unknown; detail?: unknown; message?: unknown };
    throw new ApiError(
      response.status,
      typeof problem.code === 'string' ? problem.code : null,
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.message === 'string'
          ? problem.message
          : response.statusText,
    );
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export type EmploymentStatus = 'active' | 'suspended' | 'resigned' | 'terminated';
export type PayoutMethod = 'cash' | 'bank' | 'bkash' | 'nagad';
export type AttendanceStatus =
  | 'present'
  | 'late'
  | 'half_day'
  | 'absent'
  | 'leave_unpaid'
  | 'leave_paid'
  | 'weekly_off'
  | 'holiday';
export type RunStatus = 'draft' | 'pending_approval' | 'posted' | 'paid' | 'rejected' | 'cancelled';
export type LoanStatus = 'pending_disbursement' | 'active' | 'settled' | 'written_off';

export interface Employee {
  readonly id: string;
  readonly code: string;
  readonly fullName: string;
  readonly designation: string | null;
  readonly department: string | null;
  readonly branchId: string | null;
  readonly userId: string | null;
  readonly joinDate: string;
  readonly leaveDate: string | null;
  readonly status: EmploymentStatus;
  readonly calendarId: string | null;
  readonly payoutMethod: PayoutMethod;
  /** Masks. The plain values never leave the server (invariant 10). */
  readonly payoutRefMasked: string | null;
  readonly nationalIdMasked: string | null;
  readonly phoneMasked: string | null;
}

export interface SalaryComponent {
  readonly direction: 'earning' | 'deduction';
  readonly code: string;
  readonly label: string;
  readonly amountPoisha: string;
  readonly prorated: boolean;
}

export interface SalaryStructure {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveFrom: string;
  readonly basicPoisha: string;
  readonly note: string | null;
  readonly components: readonly SalaryComponent[];
}

export interface AttendanceDay {
  readonly id: string;
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly businessDate: string;
  readonly status: AttendanceStatus;
  readonly checkInAt: string | null;
  readonly checkOutAt: string | null;
  readonly source: 'manual' | 'csv_import' | 'device';
  readonly note: string | null;
}

export interface AttendanceImportResult {
  readonly id: string | null;
  readonly month: string;
  readonly status: 'parsed' | 'applied' | 'rejected';
  readonly rowCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly rejected: readonly { readonly line: number; readonly reason: string }[];
  readonly missingColumns: readonly string[];
  readonly unknownCodes: readonly string[];
}

export interface PayrollRun {
  readonly id: string;
  readonly month: string;
  readonly status: RunStatus;
  readonly unrecordedPolicy: 'present' | 'absent';
  readonly employeeCount: number;
  readonly grossPoisha: string;
  readonly deductionsPoisha: string;
  readonly netPoisha: string;
  readonly approvalId: string | null;
  readonly approvalStatus: string | null;
  readonly journalId: string | null;
  readonly paymentJournalId: string | null;
  readonly postedOn: string | null;
  readonly paidOn: string | null;
  readonly memo: string | null;
  readonly createdBy: string;
}

export interface Payslip {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly branchId: string | null;
  readonly basicPoisha: string;
  readonly allowancesPoisha: string;
  readonly bonusPoisha: string;
  readonly grossPoisha: string;
  readonly absenceDeductionPoisha: string;
  readonly fixedDeductionPoisha: string;
  readonly otherDeductionPoisha: string;
  readonly loanDeductionPoisha: string;
  readonly loanShortfallPoisha: string;
  readonly deductionsPoisha: string;
  readonly netPoisha: string;
  readonly workingDays: number;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly halfDays: number;
  readonly unrecordedDays: number;
  readonly components: readonly {
    readonly direction: 'earning' | 'deduction';
    readonly code: string;
    readonly label: string;
    readonly amountPoisha: string;
  }[];
}

export interface RunPreview {
  readonly run: PayrollRun;
  readonly totals: Record<string, string | number>;
  readonly payslips: readonly Payslip[];
  readonly warnings: readonly string[];
}

export interface PayrollInput {
  readonly id: string;
  readonly employeeId: string;
  readonly kind: 'bonus' | 'deduction';
  readonly label: string;
  readonly amountPoisha: string;
  readonly note: string | null;
}

export interface LoanInstalment {
  readonly id: string;
  readonly seq: number;
  readonly dueMonth: string;
  readonly amountPoisha: string;
  readonly deductedPoisha: string;
  readonly status: 'due' | 'partly_deducted' | 'deducted' | 'waived';
}

export interface Loan {
  readonly id: string;
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly principalPoisha: string;
  readonly instalmentCount: number;
  readonly firstMonth: string;
  readonly status: LoanStatus;
  readonly journalId: string | null;
  readonly disbursedOn: string | null;
  readonly note: string | null;
  readonly outstandingPoisha: string;
  readonly instalments: readonly LoanInstalment[];
}

export interface WorkCalendar {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly weeklyOff: readonly number[];
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly holidays: readonly { readonly date: string; readonly label: string }[];
}

// --- employees ----------------------------------------------------------------

export function listEmployees(input: {
  readonly q?: string | undefined;
  readonly branchId?: string | undefined;
  readonly status?: string | undefined;
  readonly page?: number;
  readonly pageSize?: number;
}): Promise<{ items: Employee[]; page: number; pageSize: number }> {
  return api.get(
    `/v1/hr/employees${query({
      q: input.q,
      branchId: input.branchId,
      status: input.status,
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 50,
    })}`,
  );
}

export function getEmployee(id: string): Promise<Employee> {
  return api.get(`/v1/hr/employees/${id}`);
}

export function createEmployee(input: {
  readonly code: string;
  readonly fullName: string;
  readonly joinDate: string;
  readonly designation?: string;
  readonly department?: string;
  readonly branchId?: string;
  readonly payoutMethod: PayoutMethod;
  readonly payoutRef?: string;
  readonly nationalId?: string;
  readonly phone?: string;
}): Promise<Employee> {
  return api.post('/v1/hr/employees', input);
}

export function listStructures(employeeId: string): Promise<{ items: SalaryStructure[] }> {
  return api.get(`/v1/hr/employees/${employeeId}/salary`);
}

export function setStructure(
  employeeId: string,
  input: {
    readonly effectiveFrom: string;
    readonly basicPoisha: string;
    readonly note?: string;
    readonly components: readonly {
      readonly direction: 'earning' | 'deduction';
      readonly code: string;
      readonly label: string;
      readonly amountPoisha: string;
      readonly prorated?: boolean;
    }[];
  },
): Promise<SalaryStructure> {
  return api.post(`/v1/hr/employees/${employeeId}/salary`, input);
}

export function listCalendars(): Promise<{ items: WorkCalendar[] }> {
  return api.get('/v1/hr/calendars');
}

// --- attendance ---------------------------------------------------------------

export function listAttendance(input: {
  readonly month: string;
  readonly employeeId?: string | undefined;
  readonly branchId?: string | undefined;
}): Promise<{ items: AttendanceDay[] }> {
  return api.get(
    `/v1/hr/attendance${query({
      month: input.month,
      employeeId: input.employeeId,
      branchId: input.branchId,
    })}`,
  );
}

export function recordAttendance(
  entries: readonly {
    readonly employeeId: string;
    readonly businessDate: string;
    readonly status: AttendanceStatus;
    readonly note?: string;
  }[],
): Promise<{ recorded: number }> {
  return send('PUT', '/v1/hr/attendance', { entries });
}

export function importAttendance(input: {
  readonly month: string;
  readonly csv: string;
  readonly fileName?: string;
  readonly mapping: {
    readonly employeeCode: string;
    readonly date: string;
    readonly status?: string;
    readonly checkIn?: string;
    readonly checkOut?: string;
  };
  readonly apply: boolean;
}): Promise<AttendanceImportResult> {
  return api.post('/v1/hr/attendance/imports', input);
}

// --- payroll ------------------------------------------------------------------

export function listRuns(input: { readonly status?: string | undefined } = {}): Promise<{
  items: PayrollRun[];
}> {
  return api.get(`/v1/hr/payroll/runs${query({ status: input.status })}`);
}

export function getRun(id: string): Promise<PayrollRun> {
  return api.get(`/v1/hr/payroll/runs/${id}`);
}

export function createRun(input: {
  readonly month: string;
  readonly unrecordedPolicy?: 'present' | 'absent';
  readonly memo?: string;
}): Promise<PayrollRun> {
  return api.post('/v1/hr/payroll/runs', input);
}

export function previewRun(id: string): Promise<RunPreview> {
  return api.get(`/v1/hr/payroll/runs/${id}/preview`);
}

export function listRunInputs(id: string): Promise<{ items: PayrollInput[] }> {
  return api.get(`/v1/hr/payroll/runs/${id}/inputs`);
}

export function addRunInput(
  id: string,
  input: {
    readonly employeeId: string;
    readonly kind: 'bonus' | 'deduction';
    readonly label: string;
    readonly amountPoisha: string;
    readonly note?: string;
  },
): Promise<{ id: string }> {
  return api.post(`/v1/hr/payroll/runs/${id}/inputs`, input);
}

export function removeRunInput(id: string, inputId: string): Promise<{ removed: boolean }> {
  return send('DELETE', `/v1/hr/payroll/runs/${id}/inputs/${inputId}`);
}

export function submitRun(id: string, reason?: string): Promise<PayrollRun> {
  return api.post(`/v1/hr/payroll/runs/${id}/submit`, reason === undefined ? {} : { reason });
}

export function cancelRun(id: string): Promise<PayrollRun> {
  return api.post(`/v1/hr/payroll/runs/${id}/cancel`);
}

export function payRun(
  id: string,
  input: { readonly walletAccountId: string; readonly memo?: string },
): Promise<PayrollRun> {
  return api.post(`/v1/hr/payroll/runs/${id}/pay`, input);
}

export function listPayslips(id: string): Promise<{ items: Payslip[] }> {
  return api.get(`/v1/hr/payroll/runs/${id}/payslips`);
}

/**
 * The payslip PDF's URL.
 *
 * A URL rather than a fetch, because the browser's own download is what the user wants:
 * `Content-Disposition: attachment` and the filename the server chose. The session cookie
 * travels with a top-level navigation, so no token has to appear in the address bar —
 * which is the whole reason this is not a signed link (§22, and `payslip.service.ts`).
 */
export function payslipPdfUrl(runId: string, employeeId: string): string {
  return new URL(
    `/v1/hr/payroll/runs/${runId}/payslips/${employeeId}/pdf`,
    env.VITE_API_URL,
  ).toString();
}

// --- loans --------------------------------------------------------------------

export function listLoans(
  input: { readonly employeeId?: string | undefined; readonly status?: string | undefined } = {},
): Promise<{ items: Loan[] }> {
  return api.get(`/v1/hr/loans${query({ employeeId: input.employeeId, status: input.status })}`);
}

export function createLoan(input: {
  readonly employeeId: string;
  readonly principalPoisha: string;
  readonly instalmentCount: number;
  readonly firstMonth: string;
  readonly note?: string;
}): Promise<Loan> {
  return api.post('/v1/hr/loans', input);
}

export function disburseLoan(
  id: string,
  input: { readonly walletAccountId: string; readonly memo?: string },
): Promise<Loan> {
  return api.post(`/v1/hr/loans/${id}/disburse`, input);
}

/**
 * The org's wallets, for the "pay from" picker.
 *
 * `/v1/ledger/wallets` is M03's endpoint and returns `accountId` — which is what the
 * payroll and loan endpoints take, because HR posts through the ledger and never touches
 * the wallets module's own tables (invariant 12).
 */
export interface WalletOption {
  readonly accountId: string;
  readonly name: string;
  readonly subtype: string;
  readonly branchId: string | null;
}

export function listWallets(): Promise<{ items: WalletOption[] }> {
  return api.get('/v1/ledger/wallets');
}
