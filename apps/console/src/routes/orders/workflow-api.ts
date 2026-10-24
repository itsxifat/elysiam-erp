import type { CourierBookingPolicy } from '@elysium/contracts';

import { api } from '../../api.js';
import type { OrderRow, OrderStatus } from './api.js';
import { ackHeaders } from './owner-ack.js';

/**
 * The order workflow's endpoints (M41, D-710 to D-720), typed to what the server returns.
 *
 * Hand-written for the reason the rest of the orders client gives. **Every amount is a decimal
 * string of poisha.** No cost field anywhere (invariant 5).
 */

// --- ownership ----------------------------------------------------------------------

export const takeOrder = (id: string) => api.post<OrderRow>(`/v1/orders/${id}/claim`);
export const releaseOrder = (id: string) => api.post<OrderRow>(`/v1/orders/${id}/release`);
export const assignOrder = (id: string, assignedTo: string) =>
  api.post<OrderRow>(`/v1/orders/${id}/assign`, { assignedTo });

// --- calls --------------------------------------------------------------------------

export const CALL_OUTCOMES = ['reached', 'no_answer', 'busy', 'wrong_number', 'call_back'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface CallAttempt {
  readonly id: string;
  readonly outcome: CallOutcome;
  readonly callBackAt: string | null;
  readonly note: string | null;
  readonly calledBy: string;
  readonly calledAt: string;
}

export const listCalls = (id: string) =>
  api.get<{ orderId: string; items: CallAttempt[] }>(`/v1/orders/${id}/calls`);

export const logCall = (
  id: string,
  input: { outcome: CallOutcome; callBackAt?: string; note?: string },
  ack?: boolean,
) => api.post<CallAttempt>(`/v1/orders/${id}/calls`, input, ackHeaders(ack));

// --- the queues ---------------------------------------------------------------------

export type HubStage = 'to_print' | 'packing' | 'packed' | 'handed_over';

export type WorkflowQueue =
  | 'new'
  | 'mine'
  | 'verifying'
  | 'callbacks'
  | 'confirmed_today'
  | 'hub_print'
  | 'hub_packing'
  | 'hub_packed'
  | 'hub_handed';

/** An order as the queues list it: the order desk's row and M41's fields. */
export interface QueuedOrder extends OrderRow {
  readonly assignedAt: string | null;
  readonly locationId: string | null;
  readonly calls: {
    readonly attempts: number;
    readonly lastOutcome: CallOutcome | null;
    readonly lastAt: string | null;
    readonly callBackAt: string | null;
  };
  readonly slipPrintedAt: string | null;
  readonly hubStage: HubStage | null;
  readonly itemCount: number;
}

export function listQueue(
  queue: WorkflowQueue,
  options: { readonly locationId?: string | undefined; readonly status?: OrderStatus } = {},
) {
  const search = new URLSearchParams({ queue, limit: '100' });
  if (options.locationId !== undefined) search.set('locationId', options.locationId);
  if (options.status !== undefined) search.set('status', options.status);
  return api.get<{ items: QueuedOrder[]; hasNext: boolean }>(`/v1/orders?${search.toString()}`);
}

/** The orders one person holds, for the team board's reassign. */
export const listQueueOf = (userId: string) =>
  api.get<{ items: QueuedOrder[]; hasNext: boolean }>(
    `/v1/orders?${new URLSearchParams({ assignedTo: userId, limit: '100' }).toString()}`,
  );

export const markPrinted = (ids: readonly string[]) =>
  api.post<{ marked: string[] }>('/v1/orders/mark-printed', { ids });

// --- offers -------------------------------------------------------------------------

export interface OfferCard {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly area: {
    readonly thana: string | null;
    readonly district: string | null;
    readonly detail: string | null;
  };
  readonly itemCount: number;
  readonly codAmountPoisha: string;
  readonly offeredAt: string;
  readonly expiresAt: string;
}

export const myOffers = () => api.get<{ items: OfferCard[] }>('/v1/orders/offers/mine');
export const acceptOffer = (id: string) =>
  api.post<{ accepted: true; orderId: string; orderNo: string }>(`/v1/orders/offers/${id}/accept`);
export const declineOffer = (id: string) =>
  api.post<{ declined: true; orderId: string }>(`/v1/orders/offers/${id}/decline`);

/** D-748: a conversation offered the same way, for a person whose desk takes messages. */
export interface ConversationOfferCard {
  readonly id: string;
  readonly conversationId: string;
  readonly channel: 'messenger' | 'instagram' | 'whatsapp';
  readonly contactName: string | null;
  readonly lastPreview: string | null;
  readonly unreadCount: number;
  readonly offeredAt: string;
  readonly expiresAt: string;
}

export const myConversationOffers = () =>
  api.get<{ items: ConversationOfferCard[] }>('/v1/inbox/offers/mine');
export const acceptConversationOffer = (id: string) =>
  api.post<{ accepted: true; conversationId: string }>(`/v1/inbox/offers/${id}/accept`);
export const declineConversationOffer = (id: string) =>
  api.post<{ declined: true; conversationId: string }>(`/v1/inbox/offers/${id}/decline`);

// --- settings and the team board ----------------------------------------------------

export interface WorkflowSettings {
  readonly autoAssign: boolean;
  readonly offerSeconds: number;
  readonly maxOpen: number;
  /** When the courier is booked (D-901). */
  readonly courierBooking: CourierBookingPolicy;
  /** Hours after the handover before an unreceived parcel is listed (D-903). */
  readonly notReceivedHours: number;
}

export const getWorkflowSettings = () => api.get<WorkflowSettings>('/v1/orders/workflow-settings');
export const saveWorkflowSettings = (input: WorkflowSettings) =>
  api.put<WorkflowSettings>('/v1/orders/workflow-settings', input);

export type PresenceState = 'active' | 'idle' | 'away';

export interface Presence {
  readonly state: PresenceState;
  readonly paused: boolean;
  readonly available: boolean;
}

export interface TeamMember {
  readonly userId: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly workTypes: readonly string[];
  readonly hubLocationId: string | null;
  readonly presence: Presence & { readonly lastSeenAt: string | null };
  readonly openOrders: number;
  readonly confirmedToday: number;
  readonly offer: {
    readonly id: string;
    readonly orderId: string;
    readonly expiresAt: string;
  } | null;
}

export const teamBoard = () =>
  api.get<{ settings: WorkflowSettings; waiting: number; people: TeamMember[]; at: string }>(
    '/v1/orders/team-board',
  );

// --- presence and desk profiles -----------------------------------------------------

export interface MyDesk {
  readonly presence: Presence & {
    readonly lastSeenAt: string | null;
    readonly beatMs: number;
    readonly awayAfterMs: number;
    readonly idleAfterMs: number;
  };
  readonly profile: {
    readonly workTypes: readonly string[];
    readonly hubLocationId: string | null;
    readonly defaultProfile: boolean;
  };
}

export const myDesk = () => api.get<MyDesk>('/v1/team/me');
export const reportPresence = (input: { visible: boolean; idleSeconds: number }) =>
  api.post<Presence>('/v1/team/presence', input);
export const setPaused = (paused: boolean) =>
  api.post<Presence>('/v1/team/presence/pause', { paused });

export interface DeskProfile {
  readonly userId: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly workTypes: readonly string[];
  readonly hubLocationId: string | null;
  readonly defaultProfile: boolean;
  readonly presence: Presence;
}

export const listDeskProfiles = () => api.get<{ items: DeskProfile[] }>('/v1/team/profiles');
export const saveDeskProfile = (
  userId: string,
  input: { workTypes: readonly string[]; hubLocationId: string | null },
) => api.put<DeskProfile>(`/v1/team/profiles/${encodeURIComponent(userId)}`, input);
