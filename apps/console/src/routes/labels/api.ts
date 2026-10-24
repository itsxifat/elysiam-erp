import { TERMINAL_DEVICE_HEADER, type CourierBookingPolicy } from '@elysium/contracts';

import { api, request } from '../../api.js';
import { env } from '../../env.js';
import { terminalToken } from './terminal-binding.js';

/**
 * Labels and Packaging's endpoints (M46, D-800 to D-826), typed to what the server returns. A
 * computer bound to a terminal sends its token (`x-terminal-device`) with the terminal's work.
 */

export function terminalHeaders(): Record<string, string> {
  const token = terminalToken();
  return token === null ? {} : { [TERMINAL_DEVICE_HEADER]: token };
}

export interface PersonRef {
  readonly id: string;
  readonly name: string | null;
}

export type PrinterState = 'online' | 'offline' | 'error' | 'unknown' | 'off';
export type PresenceState = 'active' | 'idle' | 'away';
export type TerminalKind = 'packing' | 'label';

export interface TerminalCard {
  readonly id: string;
  readonly kind: TerminalKind;
  readonly name: string;
  readonly locationId: string | null;
  readonly active: boolean;
  readonly members: readonly PersonRef[];
  readonly devices: readonly {
    readonly id: string;
    readonly label: string;
    readonly lastSeenAt: string | null;
    readonly lastUser: PersonRef | null;
  }[];
  readonly workingNow: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly since: string | null;
    readonly deviceLabel: string;
    readonly presence: PresenceState;
  }[];
  readonly cameras: readonly {
    readonly id: string;
    readonly name: string;
    readonly state: 'off' | 'ready' | 'offline';
  }[];
  readonly printers: readonly {
    readonly id: string;
    readonly name: string;
    readonly connection: string;
    readonly documents: readonly string[];
    readonly state: PrinterState;
    readonly detail: string | null;
  }[];
  readonly queued: number;
  readonly packingNow: { readonly orderNo: string; readonly by: string | null } | null;
  readonly packedToday: number;
  readonly ordersPerHour: number;
}

export interface TerminalsView {
  readonly canEdit: boolean;
  readonly terminals: readonly TerminalCard[];
  readonly people: readonly {
    readonly id: string;
    readonly name: string;
    readonly roles: readonly string[];
  }[];
}

export const listTerminals = () => api.get<TerminalsView>('/v1/terminals');

export const createTerminal = (input: {
  kind: TerminalKind;
  name: string;
  locationId: string | null;
}) => api.post<{ id: string }>('/v1/terminals', input);

export const updateTerminal = (
  id: string,
  input: { name: string; locationId: string | null; active: boolean },
) => api.put(`/v1/terminals/${id}`, input);

export const setTerminalMembers = (id: string, userIds: readonly string[]) =>
  api.put(`/v1/terminals/${id}/members`, { userIds });

export const setTerminalCameras = (id: string, cameraIds: readonly string[]) =>
  api.put(`/v1/terminals/${id}/cameras`, { cameraIds });

export interface BoundTerminal {
  readonly token: string;
  readonly device: { readonly id: string; readonly label: string };
  readonly terminal: { readonly id: string; readonly kind: TerminalKind; readonly name: string };
}

/** This computer's binding goes with it: a computer bound already is moved, not bound twice. */
export const bindTerminal = (id: string, label: string) =>
  api.post<BoundTerminal>(`/v1/terminals/${id}/bind`, { label }, terminalHeaders());

export const revokeDevice = (deviceId: string) =>
  api.post(`/v1/terminals/devices/${deviceId}/revoke`);

export interface CheckIn {
  readonly terminal: { readonly id: string; readonly kind: TerminalKind; readonly name: string };
  readonly device: { readonly id: string; readonly label: string };
  readonly assigned: boolean;
  readonly supervisor: boolean;
}

export const checkIn = () =>
  request<CheckIn>('/v1/terminals/check-in', { method: 'POST', headers: terminalHeaders() });

// --- printers -------------------------------------------------------------------------------

export type PrinterConnection = 'ipp' | 'ipps' | 'raw' | 'browser';
export type PrinterLanguage = 'pdf' | 'tspl' | 'zpl' | 'escpos';
export type PrinterMedium = '4x6' | '100x150' | 'a5' | 'a4' | 'custom';
export type PrintDocument = 'label' | 'packing_slip';

export interface Printer {
  readonly id: string;
  readonly terminalId: string;
  readonly name: string;
  readonly connection: PrinterConnection;
  readonly language: PrinterLanguage;
  readonly medium: PrinterMedium;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly dpi: number;
  readonly documents: readonly PrintDocument[];
  readonly copies: number;
  readonly enabled: boolean;
  readonly state: PrinterState;
  readonly statusDetail: string | null;
  readonly statusAt: string | null;
  /** For a supervisor only. */
  readonly host?: string | null;
  readonly port?: number | null;
  readonly ippPath?: string;
  readonly username?: string;
  readonly passwordSet?: boolean;
}

export interface PrintersView {
  readonly canEdit: boolean;
  readonly credentialsKey: boolean;
  readonly printers: readonly Printer[];
}

export const listPrinters = () => api.get<PrintersView>('/v1/labels/printers');

export interface PrinterInput {
  readonly terminalId: string;
  readonly name: string;
  readonly connection: PrinterConnection;
  readonly language: PrinterLanguage;
  readonly host: string | null;
  readonly port: number | null;
  readonly ippPath: string;
  readonly dpi: 203 | 300;
  readonly medium: PrinterMedium;
  readonly widthMm: number | null;
  readonly heightMm: number | null;
  readonly documents: readonly PrintDocument[];
  readonly copies: number;
  readonly username: string;
  readonly password?: string | null;
  readonly enabled: boolean;
}

export const addPrinter = (input: PrinterInput) => api.post<Printer>('/v1/labels/printers', input);
export const updatePrinter = (id: string, input: PrinterInput) =>
  api.put<Printer>(`/v1/labels/printers/${id}`, input);
export const deletePrinter = (id: string) => api.delete(`/v1/labels/printers/${id}`);
export const testPrint = (id: string) => api.post(`/v1/labels/printers/${id}/test`);

export interface LabelSettings {
  readonly autoPrint: boolean;
  readonly autoPrintSetting: boolean | null;
  readonly autoSlip: boolean;
  readonly printers: number;
  /** When the courier is booked (D-908). A label prints on Confirm either way (D-914). */
  readonly courierBooking: CourierBookingPolicy;
  readonly canEdit: boolean;
}

export const labelSettings = () => api.get<LabelSettings>('/v1/labels/settings');
export const saveLabelSettings = (input: { autoPrint: boolean; autoSlip: boolean }) =>
  api.put('/v1/labels/settings', input);

// --- the queue and the log -------------------------------------------------------------------

export type JobState = 'queued' | 'sending' | 'printed' | 'failed' | 'cancelled';
export type JobSource = 'auto' | 'manual' | 'reprint' | 'test';

export interface PrintJob {
  readonly id: string;
  readonly orderId: string | null;
  readonly orderNo: string;
  readonly document: PrintDocument | 'test';
  readonly lot: number;
  readonly lotCount: number;
  readonly printer: {
    readonly id: string;
    readonly name: string;
    readonly connection: string | null;
  };
  readonly terminal: { readonly id: string; readonly name: string };
  readonly source: JobSource;
  readonly reason: string | null;
  readonly requestedBy: PersonRef | null;
  readonly confirmedBy: PersonRef | null;
  readonly copies: number;
  readonly consignmentNo: string | null;
  readonly state: JobState;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly printedAt: string | null;
  readonly failedAt: string | null;
}

export interface JobFilters {
  readonly view: 'queue' | 'log';
  readonly state?: JobState | undefined;
  readonly source?: JobSource | undefined;
  readonly q?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly orderId?: string | undefined;
  readonly limit?: number;
  readonly offset?: number;
}

function jobSearch(filters: JobFilters): string {
  const search = new URLSearchParams({ view: filters.view });
  for (const key of ['state', 'source', 'q', 'from', 'to', 'orderId'] as const) {
    const value = filters[key];
    if (value !== undefined && value !== '') search.set(key, value);
  }
  search.set('limit', String(filters.limit ?? 50));
  search.set('offset', String(filters.offset ?? 0));
  return search.toString();
}

export const listJobs = (filters: JobFilters) =>
  api.get<{ total: number; items: PrintJob[] }>(`/v1/labels/jobs?${jobSearch(filters)}`);

export const exportJobsUrl = (filters: JobFilters) =>
  new URL(
    `/v1/labels/jobs/export?${jobSearch({ ...filters, limit: 200 })}`,
    env.VITE_API_URL,
  ).toString();

export const retryJob = (id: string) => api.post(`/v1/labels/jobs/${id}/retry`);
export const cancelJob = (id: string) => api.post(`/v1/labels/jobs/${id}/cancel`);

export interface PrintRequest {
  readonly orderIds: readonly string[];
  readonly documents: readonly PrintDocument[];
  readonly lots?: readonly number[];
  readonly reason?: string;
  readonly printerId?: string;
}

export const printNow = (input: PrintRequest) =>
  request<{ jobs: PrintJob[] }>('/v1/labels/print', {
    method: 'POST',
    body: input,
    headers: terminalHeaders(),
  });

export interface ReadyOrder {
  readonly orderId: string;
  readonly orderNo: string;
  /** Null until the courier gives the parcel one (D-914): "Not booked yet". */
  readonly consignmentNo: string | null;
  readonly courier: string | null;
  readonly customer: string;
  readonly locationId: string | null;
  readonly bookedAt: string | null;
  readonly lotCount: number;
  readonly labelsPrinted: number;
  readonly pieces: number;
  readonly codPoisha: string;
}

export const readyForLabel = (locationId: string | undefined) =>
  api.get<{ items: ReadyOrder[] }>(
    `/v1/labels/ready${locationId === undefined ? '' : `?locationId=${locationId}`}`,
  );

export const setLotCount = (orderId: string, count: number) =>
  api.put<{ lotCount: number }>(`/v1/packing/orders/${orderId}/lots`, { count });

export interface OrderPrints {
  readonly orderId: string;
  readonly lotCount: number;
  readonly lots: readonly {
    readonly lot: number;
    readonly label: PrintTally;
    readonly slip: PrintTally;
    readonly handedAt: string | null;
  }[];
  readonly history: readonly PrintJob[];
}

export interface PrintTally {
  readonly count: number;
  readonly last: {
    readonly at: string;
    readonly by: string | null;
    readonly auto: boolean;
    readonly terminal: string | null;
  } | null;
}

export const orderPrints = (orderId: string) =>
  api.get<OrderPrints>(`/v1/labels/orders/${orderId}`);

// --- the browser print station (D-816) -----------------------------------------------------

export const stationJobs = () =>
  request<{ terminal: { id: string; name: string }; items: PrintJob[] }>(
    '/v1/labels/station/jobs',
    { headers: terminalHeaders() },
  );

/** One job's PDF, fetched with the session and the binding (same-origin as a blob). */
export async function stationDocument(jobId: string): Promise<Blob> {
  const response = await fetch(
    new URL(`/v1/labels/station/jobs/${jobId}/document`, env.VITE_API_URL),
    { credentials: 'include', headers: terminalHeaders() },
  );
  if (!response.ok)
    throw new Error(`The print job could not be fetched (${String(response.status)}).`);
  return response.blob();
}

export const stationResult = (jobId: string, result: 'printed' | 'failed', error?: string) =>
  request(`/v1/labels/station/jobs/${jobId}/result`, {
    method: 'POST',
    body: error === undefined ? { result } : { result, error: error.slice(0, 300) },
    headers: terminalHeaders(),
  });

// --- the handover (D-808) --------------------------------------------------------------------

export interface HandoverProgress {
  readonly orderId: string;
  readonly orderNo: string;
  readonly lotCount: number;
  readonly scanned: readonly number[];
  readonly missing: readonly number[];
  readonly complete: boolean;
}

export const handoverScan = (code: string) =>
  request<{
    outcome: 'accepted' | 'already';
    /** The order's courier, for the courier portal's counts (D-904). */
    order: HandoverProgress & { readonly courier: string | null };
  }>('/v1/packing/handover/scans', { method: 'POST', body: { code }, headers: terminalHeaders() });

export const handoverPending = () =>
  api.get<{
    items: (HandoverProgress & {
      customer: string;
      courier: string | null;
      lastScanAt: string | null;
    })[];
  }>('/v1/packing/handover');

export const handOver = (orderIds: readonly string[]) =>
  api.post<{
    moved: number;
    results: { id: string; orderNo: string | null; ok: boolean; code?: string; message?: string }[];
  }>('/v1/packing/handover', { orderIds });
