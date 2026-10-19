import { OWNER_ACK_HEADER } from '@elysium/contracts';
import type {
  CallerPanelAnswer,
  CallerPanelCall,
  CallerPanelFull,
  CallerPanelOrder,
  CallerPanelPinnedNote,
  CustomerPinnedNoteAnswer,
} from '@elysium/contracts/telephony';

import { api, request, ApiError, NetworkError } from '../../api.js';
import { env } from '../../env.js';

/**
 * Phone calls through Envo (M47, D-830 to D-853): the endpoints the console calls, typed to what
 * the server returns. No shape here ever carries an API key or a webhook secret.
 */

export const TELEPHONY_KEY = ['telephony'] as const;
export const CALLS_KEY = ['telephony', 'calls'] as const;
export const MY_PHONE_KEY = ['telephony', 'me'] as const;
/** The viewer's own calls that wait for their wrap-up (D-859). */
export const WRAP_UPS_KEY = ['telephony', 'wrap-ups'] as const;

export interface PersonRef {
  readonly id: string;
  readonly name: string | null;
}

export type CallDirection = 'inbound' | 'outbound' | 'internal' | 'unknown';
/** A call's result after it (D-859): M41's five. */
export type CallResult = 'reached' | 'no_answer' | 'busy' | 'wrong_number' | 'call_back';

/** The person's wrap-up of a call (D-859), as written once. */
export interface CallWrapUp {
  readonly result: CallResult;
  readonly note: string | null;
  readonly callBackAt: string | null;
  readonly byUserId: string;
  readonly byName: string | null;
  readonly at: string;
}
export type CallStatus = 'requested' | 'dialing' | 'failed' | 'ringing' | 'answered' | 'ended';

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
  /** Whether Envo named a recording of it (D-858); it plays while Envo still has it. */
  readonly recording: { readonly playable: boolean };
  readonly outcome: string | null;
  readonly wrapUp: CallWrapUp | null;
  /** What the ERP suggests the result was, or null when it cannot tell. */
  readonly suggestedResult: CallResult | null;
  /** The viewer's own ended call, not yet wrapped up. */
  readonly canWrapUp: boolean;
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

/** The call log, its filters in the body: a phone filter stays out of URLs and access logs. */
export const listCalls = (filters: CallFilters) =>
  api.post<{ readonly items: readonly PhoneCallView[]; readonly nextCursor: string | null }>(
    '/v1/telephony/calls/search',
    Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== undefined && value !== ''),
    ),
  );

export const getCall = (id: string) => api.get<PhoneCallView>(`/v1/telephony/calls/${id}`);

/** Whom a Call rings: an order, a customer, a conversation (D-862) or a phone. */
export interface CallTarget {
  readonly orderId?: string;
  readonly customerId?: string;
  readonly conversationId?: string;
  readonly phone?: string;
}

/**
 * Call a customer from your own extension; a colleague's order or conversation needs the
 * acknowledgement.
 */
export const placeCall = (target: CallTarget, acknowledge = false) =>
  api.post<{ readonly call: PhoneCallView; readonly repeated: boolean }>(
    '/v1/telephony/calls',
    target,
    acknowledge ? { [OWNER_ACK_HEADER]: '1' } : undefined,
  );

export interface WrapUpInput {
  readonly result: CallResult;
  readonly note?: string;
  readonly callBackAt?: string;
}

/**
 * Wrap up the viewer's own call, once (D-859). On a callable order it is also M41's attempt, so a
 * colleague's order needs the acknowledgement.
 */
export const wrapUpCall = (id: string, input: WrapUpInput, acknowledge = false) =>
  api.post<{ readonly call: PhoneCallView; readonly orderAttempt: boolean }>(
    `/v1/telephony/calls/${id}/wrap-up`,
    input,
    acknowledge ? { [OWNER_ACK_HEADER]: '1' } : undefined,
  );

/** The viewer's own calls that ended in the last day and wait for their wrap-up. */
export const listWrapUps = () =>
  api.get<{ readonly items: readonly PhoneCallView[] }>('/v1/telephony/calls/wrap-ups');

export const answeredHere = (from: string) =>
  api.post<PhoneCallView>('/v1/telephony/calls/answered', { from });

/**
 * Where the player streams a call's recording from (D-858): the API, which passes it on from Envo
 * with the listener's range. The session cookie goes with the audio element's request as with
 * every other (same site); it is never a public link.
 */
export const recordingUrl = (id: string) =>
  new URL(`/v1/telephony/calls/${id}/recording`, env.VITE_API_URL).toString();

/**
 * Why a recording did not play, read from a one-byte request (an audio element hears only that it
 * failed): the API's refusal, the network's, or null when it plays after all.
 */
export async function recordingProblem(id: string): Promise<ApiError | NetworkError | null> {
  let response: Response;
  try {
    response = await fetch(recordingUrl(id), {
      credentials: 'include',
      headers: { range: 'bytes=0-0' },
    });
  } catch (cause) {
    return new NetworkError(cause);
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const problem = (await response.json().catch(() => ({}))) as {
    code?: unknown;
    detail?: unknown;
  };
  return new ApiError(
    response.status,
    typeof problem.code === 'string' ? problem.code : null,
    typeof problem.detail === 'string' ? problem.detail : response.statusText,
  );
}

// --- the caller's own phone -------------------------------------------------------------------

export interface MyPhone {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly extension: string;
  readonly baseUrl: string;
  /** Whether the web phone can start (D-843); else why not. */
  readonly ready: boolean;
  readonly notReady:
    'switched_off' | 'no_key' | 'stand_in' | 'extension_off' | 'no_web_phone' | null;
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

/** A POST, so the caller's number stays out of URLs and access logs (invariant 10). */
export const lookupCaller = (phone: string) =>
  api.post<CallerLookup>('/v1/telephony/lookup', { phone });

// --- the caller panel (D-860) ---------------------------------------------------------------------

/** Whose caller panel: an incoming or placed call's number, a buyer, or a call in the log. */
export type CallerPanelTarget =
  | { readonly phone: string; readonly customerId?: string }
  | { readonly customerId: string }
  // M48 (D-887): `customerId` beside a call or a phone shows another person on that number.
  | { readonly callId: string; readonly customerId?: string };

/**
 * The panel, as the server shapes it (`@elysium/contracts/telephony`, types only). A POST, so a
 * number stays out of URLs; `ordersCursor` asks for the next page of the buyer's orders.
 */
export const fetchCallerPanel = (target: CallerPanelTarget, ordersCursor?: string) =>
  api.post<CallerPanelAnswer>('/v1/telephony/caller-panel', {
    ...target,
    ...(ordersCursor === undefined ? {} : { ordersCursor }),
  });

/** Pin a note on the buyer's panel; an empty body clears it. */
export const pinCustomerNote = (customerId: string, body: string) =>
  api.put<CustomerPinnedNoteAnswer>(`/v1/customers/${customerId}/pinned-note`, { body });

export type {
  CallerPanelAnswer,
  CallerPanelCall,
  CallerPanelFull,
  CallerPanelOrder,
  CallerPanelPinnedNote,
  CustomerPinnedNoteAnswer,
};

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
  /** `current: false` when they no longer place calls here (D-846). */
  readonly assignee: (PersonRef & { readonly current: boolean }) | null;
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
