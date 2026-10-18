import { OWNER_ACK_HEADER } from '@elysium/contracts';

import { api, request, ApiError, NetworkError } from '../../api.js';
import { env } from '../../env.js';

/**
 * Phone calls through Envo (M47, D-830 to D-853): the endpoints the console calls, typed to what
 * the server returns. No shape here ever carries an API key or a webhook secret.
 */

export const TELEPHONY_KEY = ['telephony'] as const;
export const CALLS_KEY = ['telephony', 'calls'] as const;
export const MY_PHONE_KEY = ['telephony', 'me'] as const;

export interface PersonRef {
  readonly id: string;
  readonly name: string | null;
}

export type CallDirection = 'inbound' | 'outbound' | 'internal' | 'unknown';
export type CallStatus = 'requested' | 'dialing' | 'failed' | 'ringing' | 'answered' | 'ended';
export type RecordingStatus = 'none' | 'pending' | 'stored' | 'failed' | 'expired';

export interface PhoneCallView {
  readonly id: string;
  readonly connectionId: string;
  readonly envoCallId: string | null;
  readonly firstSeen: 'click' | 'webhook' | 'sync';
  readonly direction: CallDirection;
  readonly status: CallStatus;
  readonly answered: boolean;
  readonly disposition: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly customerPhone: string | null;
  readonly extension: string | null;
  readonly person: PersonRef | null;
  readonly customer: { readonly id: string; readonly name: string | null } | null;
  readonly order: { readonly id: string; readonly orderNo: string } | null;
  readonly orderOwner: PersonRef | null;
  readonly talkSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly occurredAt: string;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  readonly recording: {
    readonly status: RecordingStatus;
    readonly playable: boolean;
    readonly error: string | null;
  };
  readonly outcome: string | null;
  readonly error: { readonly code: string; readonly detail: string | null } | null;
}

export interface CallFilters {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly userId?: string | undefined;
  readonly direction?: 'inbound' | 'outbound' | 'internal' | undefined;
  readonly answered?: 'answered' | 'missed' | undefined;
  readonly orderNo?: string | undefined;
  readonly phone?: string | undefined;
  readonly orderId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

function query(filters: CallFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export const listCalls = (filters: CallFilters) =>
  api.get<{ readonly items: readonly PhoneCallView[]; readonly nextCursor: string | null }>(
    `/v1/telephony/calls${query(filters)}`,
  );

export const getCall = (id: string) => api.get<PhoneCallView>(`/v1/telephony/calls/${id}`);

/** Call a customer from your own extension; a colleague's order needs the acknowledgement. */
export const placeCall = (
  target: { readonly orderId?: string; readonly customerId?: string; readonly phone?: string },
  acknowledge = false,
) =>
  api.post<{ readonly call: PhoneCallView; readonly repeated: boolean }>(
    '/v1/telephony/calls',
    target,
    acknowledge ? { [OWNER_ACK_HEADER]: '1' } : undefined,
  );

export const recordOutcome = (
  id: string,
  input: { readonly outcome: string; readonly callBackAt?: string; readonly note?: string },
  acknowledge = false,
) =>
  api.post<PhoneCallView>(
    `/v1/telephony/calls/${id}/outcome`,
    input,
    acknowledge ? { [OWNER_ACK_HEADER]: '1' } : undefined,
  );

export const answeredHere = (from: string) =>
  api.post<PhoneCallView>('/v1/telephony/calls/answered', { from });

/** A call's recording, as a blob the page can play (signed in, never a public link). */
export async function recordingBlob(id: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(new URL(`/v1/telephony/calls/${id}/recording`, env.VITE_API_URL), {
      credentials: 'include',
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      code?: unknown;
      detail?: unknown;
    };
    throw new ApiError(
      response.status,
      typeof problem.code === 'string' ? problem.code : null,
      typeof problem.detail === 'string' ? problem.detail : response.statusText,
    );
  }
  return response.blob();
}

// --- the caller's own phone -------------------------------------------------------------------

export interface MyPhone {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly extension: string;
  readonly baseUrl: string;
  readonly ready: boolean;
}

export const myPhone = () => api.get<{ readonly phone: MyPhone | null }>('/v1/telephony/me');

export const phoneToken = () =>
  api.get<{
    readonly token: string;
    readonly extension: string;
    readonly expiresAt: string;
    readonly baseUrl: string;
    readonly sipDomain: string | null;
  }>('/v1/telephony/phone/token');

export interface CallerLookup {
  readonly phone: string | null;
  readonly customer: {
    readonly id: string;
    readonly name: string;
    readonly reachable: boolean;
    readonly orders?: number;
    readonly delivered?: number;
    readonly returned?: number;
    readonly cancelled?: number;
  } | null;
  readonly openOrders: readonly {
    readonly id: string;
    readonly orderNo: string;
    readonly status: string;
    readonly codAmountPoisha: string;
    readonly createdAt: string;
  }[];
  readonly ringBack: {
    readonly callId: string;
    readonly order: { readonly id: string; readonly orderNo: string } | null;
  } | null;
}

export const lookupCaller = (phone: string) =>
  api.get<CallerLookup>(`/v1/telephony/lookup?phone=${encodeURIComponent(phone)}`);

// --- Settings → Calls ---------------------------------------------------------------------------

export interface ConnectionView {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly apiKeySet: boolean;
  readonly apiKeyFingerprint: string | null;
  readonly webhookSecretSet: boolean;
  readonly webhookSecretFingerprint: string | null;
  readonly recordingRetentionDays: number;
  readonly webhookPath: string;
  readonly envoServer: { readonly id: number; readonly name: string } | null;
  readonly lastTest: {
    readonly at: string;
    readonly ok: boolean;
    readonly error: string | null;
  } | null;
  readonly lastWebhook: { readonly at: string; readonly event: string | null } | null;
  readonly lastSignatureFailure: { readonly at: string; readonly reason: string | null } | null;
  readonly lastSync: { readonly at: string; readonly error: string | null } | null;
}

export interface ConnectionsView {
  readonly provider: 'http' | 'fake';
  readonly credentialsKey: boolean;
  readonly connections: readonly ConnectionView[];
}

export const CONNECTIONS_KEY = ['telephony', 'connections'] as const;

export const listConnections = () => api.get<ConnectionsView>('/v1/telephony/connections');

export interface ConnectionInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly webhookSecret?: string;
  readonly enabled: boolean;
  readonly recordingRetentionDays: number;
}

export const createConnection = (input: ConnectionInput) =>
  api.post<ConnectionView>('/v1/telephony/connections', input);

export const updateConnection = (id: string, input: ConnectionInput) =>
  api.put<ConnectionView>(`/v1/telephony/connections/${id}`, input);

export interface TestResult {
  readonly ok: true;
  readonly sipServer: { readonly id: number; readonly name: string } | null;
  readonly scopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly extensions: readonly unknown[];
  readonly numbers: readonly unknown[];
}

export const testConnection = (id: string) =>
  request<TestResult>(`/v1/telephony/connections/${id}/test`, { method: 'POST' });

export interface ExtensionRow {
  readonly extension: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly dnd: boolean;
  readonly webPhone: boolean;
  readonly online: boolean;
  readonly status: string;
  readonly inEnvo: boolean;
  readonly assignee: PersonRef | null;
}

export interface ExtensionsView {
  readonly connectionId: string;
  readonly live: boolean;
  readonly liveError: string | null;
  readonly extensions: readonly ExtensionRow[];
  readonly people: readonly {
    readonly id: string;
    readonly name: string;
    readonly roles: readonly string[];
    readonly extension: { readonly connectionId: string; readonly extension: string } | null;
  }[];
}

export const listExtensions = (connectionId: string) =>
  api.get<ExtensionsView>(`/v1/telephony/connections/${connectionId}/extensions`);

export const assignExtension = (connectionId: string, extension: string, userId: string) =>
  api.put<{ readonly extension: string }>(
    `/v1/telephony/connections/${connectionId}/extensions/${extension}`,
    { userId },
  );

export const unassignExtension = (connectionId: string, extension: string) =>
  api.delete<{ readonly extension: string }>(
    `/v1/telephony/connections/${connectionId}/extensions/${extension}`,
  );

export const listAssignments = () =>
  api.get<{
    readonly items: readonly {
      readonly userId: string;
      readonly connectionId: string;
      readonly connectionName: string;
      readonly extension: string;
    }[];
  }>('/v1/telephony/assignments');

export interface LiveCall {
  readonly id: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly state: string;
  readonly startedAt: string | null;
  readonly durationSec: number;
  readonly call: {
    readonly id: string;
    readonly person: PersonRef | null;
    readonly customerName: string | null;
    readonly orderNo: string | null;
  } | null;
}

export const liveCalls = (connectionId: string) =>
  api.get<{ readonly items: readonly LiveCall[] }>(
    `/v1/telephony/connections/${connectionId}/live`,
  );

export const hangUpLive = (connectionId: string, envoCallId: string) =>
  request<{ readonly channels: number }>(
    `/v1/telephony/connections/${connectionId}/live/${envoCallId}/hangup`,
    { method: 'POST' },
  );
