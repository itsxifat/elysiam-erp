import { api } from '../../api.js';

/**
 * The `/v1/loans/*` endpoints, typed to what the server returns (§15, §23; M26).
 *
 * Hand-written against the controller, like `../investors/api.ts`. Every amount is a
 * string of integer poisha and stays a string: `<Money>` takes it as it is, and anything
 * added up here goes through `BigInt`, never `Number`.
 */

export type LoanMethod = 'flat' | 'reducing';
export type LenderKind = 'bank' | 'person' | 'other';
export type InstalmentState = 'paid' | 'pending_approval' | 'overdue' | 'due' | 'void';

export interface LenderRow {
  readonly id: string;
  readonly name: string;
  readonly kind: LenderKind;
  readonly notes: string | null;
}

export interface LoanRow {
  readonly id: string;
  readonly lenderId: string;
  readonly lenderName: string;
  readonly reference: string | null;
  readonly principalPoisha: string;
  readonly rateBps: number;
  readonly method: LoanMethod;
  readonly tenureMonths: number;
  readonly receivedOn: string;
  readonly paidInstalments: number;
  readonly outstandingPrincipalPoisha: string;
  readonly voided: boolean;
  readonly next: {
    readonly instalmentId: string;
    readonly seq: number;
    readonly dueOn: string;
    readonly totalPoisha: string;
    readonly state: 'due' | 'overdue' | 'pending_approval';
  } | null;
}

export interface PreviewRow {
  readonly seq: number;
  readonly dueOn: string;
  readonly principalPoisha: string;
  readonly interestPoisha: string;
  readonly totalPoisha: string;
  readonly balanceAfterPoisha: string;
}

export interface Preview {
  readonly receivedOn: string;
  readonly firstDueOn: string;
  readonly instalments: readonly PreviewRow[];
  readonly totals: {
    readonly principalPoisha: string;
    readonly interestPoisha: string;
    readonly totalPoisha: string;
  };
}

export interface StatementInstalment extends PreviewRow {
  readonly id: string;
  readonly state: InstalmentState;
  readonly paymentId: string | null;
  readonly remindedOn: string | null;
}

export interface StatementPayment {
  readonly id: string;
  readonly instalmentId: string;
  readonly seq: number;
  readonly walletAccountId: string;
  readonly principalPoisha: string;
  readonly interestPoisha: string;
  readonly totalPoisha: string;
  readonly status: 'pending_approval' | 'posted' | 'rejected';
  readonly businessDate: string;
  readonly approvalRequestId: string | null;
  readonly journalId: string | null;
  readonly memo: string | null;
}

export interface Statement {
  readonly loan: {
    readonly id: string;
    readonly lenderId: string;
    readonly lenderName: string;
    readonly reference: string | null;
    readonly principalPoisha: string;
    readonly rateBps: number;
    readonly method: LoanMethod;
    readonly tenureMonths: number;
    readonly receivedOn: string;
    readonly firstDueOn: string;
    readonly reminderDays: number;
    readonly reminderPhoneMasked: string | null;
    readonly walletAccountId: string;
    readonly memo: string | null;
    readonly voidedAt: string | null;
    readonly voidReason: string | null;
    /** This viewer may void it now: the server's answer, checked again on the void. */
    readonly voidable: boolean;
  };
  readonly instalments: readonly StatementInstalment[];
  readonly payments: readonly StatementPayment[];
  readonly totals: {
    readonly paidInstalments: number;
    readonly paidPrincipalPoisha: string;
    readonly paidInterestPoisha: string;
    readonly outstandingPrincipalPoisha: string;
    readonly outstandingInterestPoisha: string;
  };
  readonly payable: {
    readonly instalmentId: string | null;
    readonly reason: 'settled' | 'waiting' | 'voided' | null;
  };
  readonly lender: {
    readonly asOf: string;
    readonly ledgerOwedPoisha: string;
    readonly scheduleOwedPoisha: string;
  };
}

export interface Terms {
  readonly principalPoisha: string;
  readonly rateBps: number;
  readonly method: LoanMethod;
  readonly tenureMonths: number;
  readonly firstDueOn?: string;
}

export function listLenders(): Promise<{ items: readonly LenderRow[] }> {
  return api.get<{ items: readonly LenderRow[] }>('/v1/loans/lenders');
}

export function createLender(input: {
  name: string;
  kind: LenderKind;
  notes?: string;
}): Promise<LenderRow> {
  return api.post<LenderRow>('/v1/loans/lenders', input);
}

export function previewSchedule(terms: Terms): Promise<Preview> {
  return api.post<Preview>('/v1/loans/preview', terms);
}

export function listLoans(): Promise<{ items: readonly LoanRow[] }> {
  return api.get<{ items: readonly LoanRow[] }>('/v1/loans');
}

export function createLoan(
  input: Terms & {
    loanId: string;
    lenderId: string;
    walletAccountId: string;
    reference?: string;
    reminderDays: number;
    reminderPhone?: string;
    memo?: string;
  },
): Promise<Statement> {
  return api.post<Statement>('/v1/loans', input);
}

export function getStatement(loanId: string): Promise<Statement> {
  return api.get<Statement>(`/v1/loans/${loanId}`);
}

export function voidLoan(loanId: string, reason: string): Promise<Statement> {
  return api.post<Statement>(`/v1/loans/${loanId}/void`, { reason });
}

export function payInstalment(
  loanId: string,
  input: { paymentId: string; instalmentId: string; walletAccountId: string; memo?: string },
): Promise<{ paymentId: string; status: 'posted' | 'pending_approval' }> {
  return api.post<{ paymentId: string; status: 'posted' | 'pending_approval' }>(
    `/v1/loans/${loanId}/payments`,
    input,
  );
}
