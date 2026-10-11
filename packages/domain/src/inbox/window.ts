/**
 * When a free-text reply may be sent (M42, D-734).
 *
 * Meta allows a business to answer a person freely only for a while after that person last
 * wrote:
 *
 * - **Messenger**: the standard messaging window, "up to 24 hours to respond to a user"
 *   (Messenger Platform policy overview), opened by the person messaging the Page.
 * - **Instagram** (through the Messenger API): "Your app has 24 hours to respond to any message
 *   sent from an Instagram user".
 * - **WhatsApp**: the customer service window, "a 24-hour timer" that starts and resets when the
 *   user messages the business; after it closes "you can only send pre-approved template
 *   messages".
 *
 * Meta's message tags (the 7-day human agent tag) need App Review and WhatsApp templates are out
 * of scope, so outside the window a reply is refused with the time the window closed. The window
 * runs from the last **inbound** message: a reply of ours does not extend it.
 */

export const INBOX_CHANNEL_KINDS = ['messenger', 'instagram', 'whatsapp'] as const;
export type InboxChannelKind = (typeof INBOX_CHANNEL_KINDS)[number];

/** Each channel's free-reply window, in milliseconds. All three are 24 hours today. */
export const REPLY_WINDOW_MS: Readonly<Record<InboxChannelKind, number>> = {
  messenger: 24 * 60 * 60 * 1000,
  instagram: 24 * 60 * 60 * 1000,
  whatsapp: 24 * 60 * 60 * 1000,
};

export type ReplyWindow =
  | { readonly open: true; readonly closesAt: Date }
  | {
      readonly open: false;
      /** `never_wrote`: the person has not messaged us; `expired`: they did, too long ago. */
      readonly reason: 'never_wrote' | 'expired';
      readonly closedAt: Date | null;
    };

export function replyWindow(
  kind: InboxChannelKind,
  lastInboundAt: Date | null,
  now: Date,
): ReplyWindow {
  if (lastInboundAt === null || Number.isNaN(lastInboundAt.getTime())) {
    return { open: false, reason: 'never_wrote', closedAt: null };
  }
  const closesAt = new Date(lastInboundAt.getTime() + REPLY_WINDOW_MS[kind]);
  if (now.getTime() < closesAt.getTime()) return { open: true, closesAt };
  return { open: false, reason: 'expired', closedAt: closesAt };
}
