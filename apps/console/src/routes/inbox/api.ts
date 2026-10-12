import {
  ACKNOWLEDGE_OWNER_HEADER,
  type InboxChannelKindName,
  type InboxContactStage,
} from '@elysium/contracts';

import { api, request } from '../../api.js';
// M45: a kept voice message or picture (`fileId`, `media`) and a call entry (`call`).
import type { MediaAttachment } from './voice/api.js';

/**
 * The inbox's endpoints (M42), typed to what the server returns. A write that may land on
 * someone else's conversation takes `acknowledged`, which sends `x-acknowledge-owner: 1`
 * (D-737); the screen only sets it after the person confirmed.
 */

export type ChannelKind = InboxChannelKindName;
export type ContactStage = InboxContactStage;
export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface PersonRef {
  readonly userId: string;
  readonly name: string | null;
}

export interface WindowView {
  readonly open: boolean;
  readonly closesAt: string | null;
  readonly reason: 'never_wrote' | 'expired' | null;
}

export interface ConversationItem {
  readonly id: string;
  readonly channel: ChannelKind;
  readonly status: 'open' | 'closed';
  readonly contact: {
    readonly id: string;
    readonly name: string | null;
    readonly stage: ContactStage;
    /** M44a (D-761): Meta's photo, an https URL that expires; null without one. */
    readonly avatarUrl: string | null;
    /** Instagram's username. */
    readonly handle: string | null;
  };
  readonly assignedTo: PersonRef | null;
  readonly assignedAt: string | null;
  readonly lastMessageAt: string;
  readonly lastPreview: string | null;
  readonly lastDirection: 'inbound' | 'outbound' | null;
  readonly unreadCount: number;
  readonly window: WindowView;
}

export interface AttachmentView extends MediaAttachment {
  readonly type: string;
  readonly url?: string;
  readonly mediaId?: string;
  readonly mimeType?: string;
  readonly caption?: string;
  readonly title?: string;
}

export interface MessageView {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly text: string | null;
  readonly attachments: readonly AttachmentView[];
  readonly status: 'received' | OutboundStatus;
  readonly sentBy: PersonRef | null;
  readonly at: string;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly error: { readonly code: string; readonly detail: string | null } | null;
}

export interface ThreadView {
  readonly conversation: ConversationItem;
  readonly messages: readonly MessageView[];
  readonly hasMore: boolean;
}

export interface PanelView {
  readonly conversationId: string;
  readonly channel: ChannelKind;
  readonly contact: {
    readonly id: string;
    readonly name: string | null;
    readonly stage: ContactStage;
    readonly stageSetAt: string | null;
    readonly phone: string | null;
    readonly address: {
      readonly districtId: number;
      readonly thanaId: number;
      readonly area: string | null;
      readonly addressLine: string;
    } | null;
    readonly tags: readonly string[];
  };
  readonly phonesFound: readonly {
    readonly phone: string;
    readonly saved: boolean;
    readonly matchesCustomer: boolean;
  }[];
  readonly addressesFound: readonly {
    readonly districtId: number;
    readonly thanaId: number;
    readonly thanaName: string;
    readonly districtName: string;
    readonly line: string;
  }[];
  readonly customer: {
    readonly id: string;
    readonly name: string;
    readonly phone: string;
    readonly orders: number;
    readonly delivered: number;
    readonly returned: number;
    readonly cancelled: number;
    readonly spentPoisha: string;
    readonly lastOrderAt: string | null;
    readonly recentOrders: readonly {
      readonly id: string;
      readonly orderNo: string;
      readonly status: string;
      readonly channel: string;
      readonly codAmountPoisha: string;
      readonly createdAt: string;
    }[];
  } | null;
  readonly notes: readonly {
    readonly id: string;
    readonly body: string;
    readonly at: string;
    readonly author: PersonRef;
  }[];
  readonly interests: readonly {
    readonly id: string;
    readonly productId: string;
    readonly skuId: string | null;
    readonly addedAt: string;
    readonly product: {
      readonly name: string;
      readonly status: 'draft' | 'active' | 'archived';
      readonly imageFileId: string | null;
      readonly minPricePoisha: string | null;
      readonly maxPricePoisha: string | null;
      readonly variants: readonly {
        readonly skuId: string;
        readonly code: string;
        readonly label: string;
        readonly pricePoisha: string;
        readonly compareAtPoisha: string | null;
        readonly available: number;
      }[];
    } | null;
  }[];
}

export interface OrderDraft {
  readonly conversationId: string;
  readonly channel: 'facebook' | 'instagram' | 'whatsapp';
  readonly phone: string | null;
  readonly name: string | null;
  readonly address: {
    readonly districtId: number;
    readonly thanaId: number;
    readonly area: string | null;
    readonly addressLine: string;
  } | null;
  readonly lines: readonly { readonly skuId: string }[];
  readonly fraud: boolean;
}

export interface ListFilters {
  readonly view: 'all' | 'mine' | 'unassigned';
  readonly channel?: ChannelKind | undefined;
  readonly stage?: ContactStage | undefined;
  readonly unread?: boolean | undefined;
  readonly closed?: boolean | undefined;
  readonly q?: string | undefined;
}

function query(params: Readonly<Record<string, string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/** A write that may land on someone else's conversation: the header only once confirmed. */
function send<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  acknowledged: boolean,
): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined ? {} : { body }),
    ...(acknowledged ? { headers: { [ACKNOWLEDGE_OWNER_HEADER]: '1' } } : {}),
  });
}

export const INBOX_KEY = ['inbox'] as const;

export const listConversations = (filters: ListFilters, before?: string) =>
  api.get<{ items: ConversationItem[]; nextBefore: string | null }>(
    `/v1/inbox/conversations${query({
      view: filters.view,
      channel: filters.channel,
      stage: filters.stage,
      unread: filters.unread === true ? 'true' : undefined,
      status: filters.closed === true ? 'any' : 'open',
      q: filters.q !== undefined && filters.q.trim().length >= 2 ? filters.q.trim() : undefined,
      before,
    })}`,
  );

export const getThread = (id: string, limit?: number) =>
  api.get<ThreadView>(
    `/v1/inbox/conversations/${encodeURIComponent(id)}${query({
      limit: limit === undefined ? undefined : String(limit),
    })}`,
  );
/** M44a (D-764): unread messages in the caller's conversations and in nobody's. */
export const getUnread = () => api.get<{ mine: number; unassigned: number }>('/v1/inbox/unread');
export const getPanel = (id: string) =>
  api.get<PanelView>(`/v1/inbox/conversations/${encodeURIComponent(id)}/panel`);
export const getOrderDraft = (id: string) =>
  api.get<OrderDraft>(`/v1/inbox/conversations/${encodeURIComponent(id)}/order-draft`);
export const getTeam = () =>
  api.get<{ items: { userId: string; name: string }[] }>('/v1/inbox/team');
export const getPhoneFlags = (phone: string) =>
  api.get<{
    phone: string | null;
    fraud: boolean;
    contacts: { id: string; name: string | null; conversationId: string | null }[];
  }>(`/v1/inbox/phone-flags${query({ phone })}`);

const at = (id: string, suffix: string) =>
  `/v1/inbox/conversations/${encodeURIComponent(id)}${suffix}`;

export type ConversationAction = 'take' | 'release' | 'close' | 'reopen';

export const act = (id: string, action: ConversationAction, acknowledged: boolean) =>
  send<unknown>('POST', at(id, `/${action}`), undefined, acknowledged);
export const markRead = (id: string) => api.post<unknown>(at(id, '/read'));
export const handOver = (id: string, userId: string, acknowledged: boolean) =>
  send<unknown>('POST', at(id, '/hand-over'), { userId }, acknowledged);
export const reply = (id: string, body: { id: string; text: string }, acknowledged: boolean) =>
  send<{ id: string; status: OutboundStatus }>('POST', at(id, '/messages'), body, acknowledged);
export const savePhone = (id: string, phone: string, acknowledged: boolean) =>
  send<unknown>('PUT', at(id, '/contact/phone'), { phone }, acknowledged);
export const saveAddress = (
  id: string,
  address: { districtId: number; thanaId: number; area?: string; addressLine: string },
  acknowledged: boolean,
) => send<unknown>('PUT', at(id, '/contact/address'), address, acknowledged);
export const setStage = (
  id: string,
  stage: 'lead' | 'not_qualified' | 'fraud' | 'auto',
  acknowledged: boolean,
) => send<unknown>('PUT', at(id, '/contact/stage'), { stage }, acknowledged);
export const setTags = (id: string, tags: readonly string[], acknowledged: boolean) =>
  send<unknown>('PUT', at(id, '/contact/tags'), { tags }, acknowledged);
export const addNote = (id: string, body: string, acknowledged: boolean) =>
  send<unknown>('POST', at(id, '/notes'), { body }, acknowledged);
export const addInterest = (
  id: string,
  interest: { productId: string; skuId?: string },
  acknowledged: boolean,
) => send<unknown>('POST', at(id, '/interests'), interest, acknowledged);
export const removeInterest = (id: string, interestId: string, acknowledged: boolean) =>
  send<unknown>(
    'DELETE',
    at(id, `/interests/${encodeURIComponent(interestId)}`),
    undefined,
    acknowledged,
  );

/** The catalog's product search, for "Interested in" (`read Catalog`). */
export const searchProducts = (q: string) =>
  api.get<{ items: { id: string; name: string; status: string }[] }>(
    `/v1/catalog/products${query({ q, limit: '8' })}`,
  );

// --- Settings → Inbox --------------------------------------------------------------------------

export interface ChannelsView {
  readonly webhookPath: string;
  readonly provider: 'graph' | 'fake';
  readonly apiVersion: string;
  readonly credentialsKey: boolean;
  readonly app: {
    readonly appSecretSet: boolean;
    readonly appSecretFingerprint: string | null;
    readonly verifyTokenSet: boolean;
    readonly verifyTokenFingerprint: string | null;
  };
  readonly channels: readonly {
    readonly kind: ChannelKind;
    readonly configured: boolean;
    readonly externalId: string | null;
    readonly enabled: boolean;
    readonly tokenSet: boolean;
    readonly tokenFingerprint: string | null;
    readonly updatedAt: string | null;
  }[];
}

export const CHANNELS_KEY = ['inbox', 'channels'] as const;
export const getChannels = () => api.get<ChannelsView>('/v1/inbox/channels');
export const saveChannel = (
  kind: ChannelKind,
  body: { externalId: string; enabled: boolean; accessToken?: string },
) => api.put<unknown>(`/v1/inbox/channels/${kind}`, body);
export const saveMetaApp = (body: { appSecret?: string; verifyToken?: string }) =>
  api.put<unknown>('/v1/inbox/meta-app', body);

// --- M44a: saved replies (D-763) ---------------------------------------------------------------

export interface SavedReply {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
  readonly body: string;
  readonly category: string | null;
  readonly usageCount: number;
  readonly lastUsedAt: string | null;
  readonly updatedAt: string;
}

export interface SavedReplyBody {
  readonly title: string;
  readonly shortcut: string;
  readonly body: string;
  readonly category?: string;
}

export const SAVED_REPLIES_KEY = ['inbox', 'saved-replies'] as const;
export const listSavedReplies = () => api.get<{ items: SavedReply[] }>('/v1/inbox/saved-replies');
export const createSavedReply = (body: SavedReplyBody) =>
  api.post<SavedReply>('/v1/inbox/saved-replies', body);
export const updateSavedReply = (id: string, body: SavedReplyBody) =>
  api.put<SavedReply>(`/v1/inbox/saved-replies/${encodeURIComponent(id)}`, body);
export const deleteSavedReply = (id: string) =>
  api.delete<unknown>(`/v1/inbox/saved-replies/${encodeURIComponent(id)}`);
/** Counted when inserted into a reply; the picker orders by it. */
export const countSavedReplyUse = (id: string) =>
  api.post<{ id: string; usageCount: number }>(
    `/v1/inbox/saved-replies/${encodeURIComponent(id)}/use`,
  );
