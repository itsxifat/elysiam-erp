/**
 * Where a message we sent stands (M42, D-735), and how each channel's receipts map onto that.
 *
 * `queued` is ours (written with the reply, before the job sends it); `sent` is Meta accepting
 * it; `delivered` and `read` come from the status webhooks; `failed` is a refusal, Meta's or our
 * own (the window closed before the job ran). Receipts arrive late, twice and out of order, so a
 * status only moves forward, and a `failed` after `delivered` is ignored: WhatsApp documents that
 * one message can be both, when the person is signed in on several devices, and "delivered" means
 * it reached at least one of them.
 */

export const OUTBOUND_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

const RANK: Readonly<Record<Exclude<OutboundStatus, 'failed'>, number>> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

export function nextOutboundStatus(
  current: OutboundStatus,
  incoming: OutboundStatus,
): OutboundStatus {
  if (incoming === 'failed') {
    return current === 'queued' || current === 'sent' ? 'failed' : current;
  }
  if (current === 'failed') {
    // A late receipt proving it reached the person outranks our record of a failure.
    return incoming === 'delivered' || incoming === 'read' ? incoming : current;
  }
  return RANK[incoming] > RANK[current] ? incoming : current;
}

/**
 * WhatsApp Cloud API status values (`statuses[].status`; the status webhook reference lists
 * sent, delivered, read, played and failed). `played` is a voice message heard, which is read.
 * Anything else is unknown and changes nothing.
 */
export const WHATSAPP_STATUS_MAP: Readonly<Record<string, OutboundStatus>> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  played: 'read',
  failed: 'failed',
};

/**
 * Messenger and Instagram receipts (D-735): `message_deliveries` (`delivery.mids`,
 * `delivery.watermark`: "All messages that were sent before this timestamp were delivered"),
 * `message_reads` (`read.watermark`) and Instagram's `messaging_seen` (`read`). Keyed by the
 * webhook event's own key.
 */
export const MESSENGER_RECEIPT_MAP: Readonly<Record<string, OutboundStatus>> = {
  delivery: 'delivered',
  read: 'read',
};

export function mapWhatsAppStatus(status: string): OutboundStatus | null {
  return Object.hasOwn(WHATSAPP_STATUS_MAP, status) ? (WHATSAPP_STATUS_MAP[status] ?? null) : null;
}
