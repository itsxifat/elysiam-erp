import type { Employee, EmploymentStatus, PayoutMethod } from './api.js';

/**
 * The edit panel's form, as typed (m30-followups).
 *
 * Every field is a string so an input can hold it as typed; an empty string means "none"
 * for the nullable fields and "unchanged" for the write-only personal ones.
 */
export interface EmployeeEditForm {
  readonly fullName: string;
  readonly designation: string;
  readonly department: string;
  /** `''` is no branch. */
  readonly branchId: string;
  readonly status: EmploymentStatus;
  /** `''` is no leaving date. */
  readonly leaveDate: string;
  readonly payoutMethod: PayoutMethod;
  /** Write-only: `''` leaves the stored number as it is. */
  readonly payoutRef: string;
  readonly nationalId: string;
  readonly phone: string;
  /** `''` is not linked to a sign-in. */
  readonly userId: string;
}

/** What `PATCH /v1/hr/employees/:id` accepts. */
export interface EmployeePatch {
  fullName?: string;
  designation?: string | null;
  department?: string | null;
  branchId?: string | null;
  status?: EmploymentStatus;
  leaveDate?: string | null;
  payoutMethod?: PayoutMethod;
  payoutRef?: string;
  nationalId?: string;
  phone?: string;
  userId?: string | null;
}

export type EmployeePatchProblem = 'nothingChanged' | 'nameRequired' | 'payoutRefRequired';

/** The form an employee row opens with. */
export function editFormFor(employee: Employee): EmployeeEditForm {
  return {
    fullName: employee.fullName,
    designation: employee.designation ?? '',
    department: employee.department ?? '',
    branchId: employee.branchId ?? '',
    status: employee.status,
    leaveDate: employee.leaveDate ?? '',
    payoutMethod: employee.payoutMethod,
    payoutRef: '',
    nationalId: '',
    phone: '',
    userId: employee.userId ?? '',
  };
}

const orNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Only what changed, so an edit never sends a field the editor may not touch.
 *
 * The server refuses payout details, the linked sign-in and bringing back a leaver from
 * anyone without `update Payroll` across the brand (D-363), and it reads "sent" as "changed":
 * a branch manager's edit that echoed the unchanged `payoutMethod` back would be refused for a
 * field they never touched. So the payroll fields are left out entirely unless
 * `mayEditPayroll`, and every other field is sent only when it differs from the row.
 */
export function employeePatch(
  employee: Employee,
  form: EmployeeEditForm,
  mayEditPayroll: boolean,
): { readonly patch: EmployeePatch; readonly problem: EmployeePatchProblem | null } {
  const patch: EmployeePatch = {};

  const fullName = form.fullName.trim();
  if (fullName === '') return { patch, problem: 'nameRequired' };
  if (fullName !== employee.fullName) patch.fullName = fullName;

  const designation = orNull(form.designation);
  if (designation !== employee.designation) patch.designation = designation;
  const department = orNull(form.department);
  if (department !== employee.department) patch.department = department;

  const branchId = form.branchId === '' ? null : form.branchId;
  if (branchId !== employee.branchId) patch.branchId = branchId;

  if (form.status !== employee.status) patch.status = form.status;
  const leaveDate = form.leaveDate === '' ? null : form.leaveDate;
  if (leaveDate !== employee.leaveDate) patch.leaveDate = leaveDate;

  if (mayEditPayroll) {
    if (form.payoutMethod !== employee.payoutMethod) patch.payoutMethod = form.payoutMethod;
    const payoutRef = form.payoutRef.trim();
    if (payoutRef !== '') patch.payoutRef = payoutRef;
    // Moving off cash needs an account number, unless one is already on file.
    if (
      form.payoutMethod !== 'cash' &&
      patch.payoutMethod !== undefined &&
      payoutRef === '' &&
      employee.payoutRefMasked === null
    ) {
      return { patch, problem: 'payoutRefRequired' };
    }
    const userId = form.userId === '' ? null : form.userId;
    if (userId !== employee.userId) patch.userId = userId;
  }

  // Personal details are any editor's, as on the add form; the server encrypts them.
  const nationalId = form.nationalId.trim();
  if (nationalId !== '') patch.nationalId = nationalId;
  const phone = form.phone.trim();
  if (phone !== '') patch.phone = phone;

  if (Object.keys(patch).length === 0) return { patch, problem: 'nothingChanged' };
  return { patch, problem: null };
}
