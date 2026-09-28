import { api, ApiError, CSRF_HEADER, csrfToken } from '../../api.js';
import { env } from '../../env.js';

/**
 * `/v1/supply/*`, typed to what the controller actually returns.
 *
 * Hand-written against the controller rather than taken from the generated client, for
 * the reason M06's catalog client gives: M04's generator types every operation's result
 * as `unknown`, and an `unknown` at the call site gets cast somewhere — a cast inside a
 * page component is a type nobody maintains.
 *
 * **Every quantity is a number and every amount is a string.** §23: integer poisha
 * crosses the wire as a decimal string, because `JSON.parse` turns a crore-scale value
 * into a double and loses its last digits. `<Money>` takes the string directly.
 *
 * **The cost and balance fields are optional in these types, and that is the point.**
 * `unitCostPoisha` is in `COST_FIELDS` so `serializeFor` removes it for any caller
 * without `read Cost`, and the supplier balances are left out by the service for the
 * same caller (§6 protects supplier balances alongside cost). Declared `| undefined` so
 * TypeScript makes each screen decide what to show when they are absent, rather than
 * rendering `undefined` into a `<Money>`.
 */

async function send<T>(method: 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  // The shared client exposes `get` and `post` only. Adding `patch` and `del` belongs in
  // that file, which is edited concurrently by other milestones in this working tree, so
  // M09's INTEGRATION section hands the integrator those methods and this helper
  // disappears with them. The two things it must not get wrong are the two the shared
  // client exists for: cookies cross-origin, and the CSRF token echoed as a header.
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

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

// --- suppliers ---------------------------------------------------------------

export interface SupplierRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly paymentTermsDays: number | null;
  readonly isActive: boolean;
  /** Withheld from a caller without `read Cost` (§6 protects supplier balances). */
  readonly duePoisha?: string;
  readonly advancePoisha?: string;
}

export interface SupplierList {
  readonly asOf: string;
  readonly costWithheld: boolean;
  readonly items: readonly SupplierRow[];
}

export function listSuppliers(filters: { q?: string; includeInactive?: boolean } = {}) {
  return api.get<SupplierList>(
    `/v1/supply/suppliers${query({
      q: filters.q,
      includeInactive: filters.includeInactive === true ? 'true' : undefined,
    })}`,
  );
}

export interface SupplierDetail extends SupplierRow {
  readonly asOf: string;
  readonly costWithheld: boolean;
  readonly contacts: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly isPrimary: boolean;
  }[];
  readonly notes: readonly {
    readonly id: string;
    readonly body: string;
    readonly createdBy: string;
    readonly createdAt: string;
  }[];
  readonly documents: readonly {
    readonly id: string;
    readonly fileObjectId: string;
    readonly label: string;
    readonly createdAt: string;
  }[];
}

export function getSupplier(id: string) {
  return api.get<SupplierDetail>(`/v1/supply/suppliers/${id}`);
}

export function createSupplier(input: {
  code: string;
  name: string;
  phone?: string;
  paymentTermsDays?: number;
}) {
  return api.post<{ id: string }>('/v1/supply/suppliers', input);
}

export function updateSupplier(id: string, patch: { isActive?: boolean; name?: string }) {
  return send<{ id: string }>('PATCH', `/v1/supply/suppliers/${id}`, patch);
}

export function addContact(
  supplierId: string,
  input: { name: string; role?: string; phone?: string; isPrimary?: boolean },
) {
  return api.post<{ id: string }>(`/v1/supply/suppliers/${supplierId}/contacts`, input);
}

export function addNote(supplierId: string, body: string) {
  return api.post<{ id: string }>(`/v1/supply/suppliers/${supplierId}/notes`, { body });
}

export interface StatementLine {
  readonly journalId: string;
  readonly lineNo: number;
  readonly businessDate: string;
  readonly sourceType: string;
  readonly account: string;
  readonly memo: string | null;
  readonly debitPoisha: string;
  readonly creditPoisha: string;
  readonly runningDuePoisha: string;
  readonly runningAdvancePoisha: string;
}

export interface Statement {
  readonly supplier: { readonly id: string; readonly code: string; readonly name: string };
  readonly from: string | null;
  readonly to: string;
  readonly openingDuePoisha: string;
  readonly openingAdvancePoisha: string;
  readonly totalDebitPoisha: string;
  readonly totalCreditPoisha: string;
  readonly closingDuePoisha: string;
  readonly closingAdvancePoisha: string;
  readonly truncated: boolean;
  readonly items: readonly StatementLine[];
}

export function getStatement(supplierId: string, range: { from?: string; to: string }) {
  return api.get<Statement>(
    `/v1/supply/suppliers/${supplierId}/statement${query({ from: range.from, to: range.to })}`,
  );
}

// --- supply entries ----------------------------------------------------------

export interface SupplyEntryRow {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly locationId: string;
  readonly branchId: string | null;
  readonly status: 'draft' | 'received';
  readonly invoiceNumber: string | null;
  readonly businessDate: string | null;
  readonly journalId: string | null;
  readonly attachmentFileId: string | null;
}

export function listEntries(filters: { supplierId?: string; status?: string } = {}) {
  return api.get<{ items: readonly SupplyEntryRow[]; costWithheld: boolean }>(
    `/v1/supply/entries${query({ supplierId: filters.supplierId, status: filters.status })}`,
  );
}

export interface SupplyEntryDetail extends SupplyEntryRow {
  readonly occurredAt: string | null;
  readonly receivedBy: string | null;
  readonly costWithheld: boolean;
  readonly totalCostPoisha?: string;
  readonly lines: readonly {
    readonly id: string;
    readonly skuId: string;
    readonly skuCode: string;
    readonly productName: string;
    readonly lineNo: number;
    readonly qty: number;
    readonly unitCostPoisha?: string | null;
  }[];
}

export function getEntry(id: string) {
  return api.get<SupplyEntryDetail>(`/v1/supply/entries/${id}`);
}

export interface EntryResult {
  readonly id: string;
  readonly status: string;
  readonly journalId: string | null;
  readonly businessDate: string | null;
  readonly totalCostPoisha?: string;
}

export function createDraft(input: {
  draftId: string;
  supplierId: string;
  locationId: string;
  invoiceNumber?: string;
  lines: readonly { skuId: string; qty: number }[];
}) {
  return api.post<{ id: string; status: string; lineCount: number }>('/v1/supply/drafts', input);
}

export function deleteDraft(id: string) {
  return send<{ id: string; deleted: boolean }>('DELETE', `/v1/supply/drafts/${id}`);
}

export function receiveEntry(
  id: string,
  input: {
    invoiceNumber?: string;
    lines: readonly { skuId: string; qty?: number; unitCostPoisha: string }[];
    memo?: string;
  },
) {
  return api.post<EntryResult>(`/v1/supply/entries/${id}/receive`, input);
}

export function createEntry(input: {
  supplyId: string;
  supplierId: string;
  locationId: string;
  invoiceNumber?: string;
  lines: readonly { skuId: string; qty: number; unitCostPoisha: string }[];
  memo?: string;
}) {
  return api.post<EntryResult>('/v1/supply/entries', input);
}

// --- returns -----------------------------------------------------------------

export interface ReturnRow {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly supplyId: string | null;
  readonly businessDate: string;
  readonly reason: string;
  readonly journalId: string | null;
  readonly creditPoisha?: string;
  readonly reliefPoisha?: string;
  readonly variancePoisha?: string;
}

export function listReturns(supplierId?: string) {
  return api.get<{ items: readonly ReturnRow[]; costWithheld: boolean }>(
    `/v1/supply/returns${query({ supplierId })}`,
  );
}

export function createReturn(input: {
  returnId: string;
  supplierId: string;
  locationId: string;
  reason: string;
  lines: readonly { skuId: string; qty: number; originalUnitCostPoisha: string }[];
}) {
  return api.post<{ id: string; journalId: string | null; creditPoisha: string }>(
    '/v1/supply/returns',
    input,
  );
}

// --- payments ----------------------------------------------------------------

export interface PaymentRow {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly walletAccountId: string;
  readonly walletCode: string;
  readonly walletName: string;
  readonly kind: 'advance' | 'payment';
  readonly status: 'pending_approval' | 'posted' | 'rejected';
  readonly amountPoisha: string;
  readonly appliedPoisha: string;
  readonly businessDate: string;
  readonly memo: string | null;
  readonly approvalRequestId: string | null;
  readonly journalId: string | null;
}

export function listPayments(filters: { supplierId?: string; kind?: string } = {}) {
  return api.get<{ items: readonly PaymentRow[] }>(
    `/v1/supply/payments${query({ supplierId: filters.supplierId, kind: filters.kind })}`,
  );
}

export function paySupplier(input: {
  paymentId: string;
  supplierId: string;
  walletAccountId: string;
  kind: 'advance' | 'payment';
  amountPoisha: string;
  memo?: string;
}) {
  return api.post<{
    paymentId: string;
    status: 'posted' | 'pending_approval';
    journalId: string | null;
    approvalId: string | null;
    amountPoisha: string;
  }>('/v1/supply/payments', input);
}

export function applyAdvance(input: {
  applicationId: string;
  paymentId: string;
  supplyId: string;
  amountPoisha: string;
}) {
  return api.post<{ id: string; journalId: string; amountPoisha: string }>(
    '/v1/supply/advance-applications',
    input,
  );
}

// --- borrowed reads ----------------------------------------------------------

/**
 * The wallets a payment can be made from, and the locations stock lands in.
 *
 * Read from M08's and M07's own endpoints rather than duplicated here: a wallet list
 * inside the supply module would be a second answer to "which tills does this brand
 * have", and the wallet's `ledgerAccountId` is exactly what `POST /payments` wants
 * (D-121).
 */
export function listWallets(asOf: string) {
  return api.get<{
    items: readonly {
      readonly id: string;
      readonly ledgerAccountId: string;
      readonly code: string;
      readonly name: string;
      readonly isActive: boolean;
    }[];
  }>(`/v1/accounts/wallets${query({ asOf })}`);
}

export function listLocations() {
  return api.get<{
    items: readonly {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly kind: string;
    }[];
  }>('/v1/inventory/locations');
}

/**
 * The SKUs a location holds, for the entry form's picker.
 *
 * M07's stock listing rather than a catalogue search: an entry names stock going
 * *somewhere*, and a picker over the whole catalogue invites a line for a SKU the
 * chosen warehouse has never held. The rows carry `wacPoisha`, which the server strips
 * for a caller without `read Cost` — the picker never shows it either way.
 */
export function listStock(input: { locationId?: string; q?: string }) {
  return api.get<{
    items: readonly {
      readonly skuId: string;
      readonly skuCode: string;
      readonly productName: string;
      readonly available: number;
    }[];
  }>(
    `/v1/inventory/stock${query({
      locationId: input.locationId,
      q: input.q,
      page: '1',
      pageSize: '200',
    })}`,
  );
}
