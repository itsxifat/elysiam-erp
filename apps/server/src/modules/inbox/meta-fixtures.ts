/**
 * Meta webhook bodies for tests (M42), shaped exactly as Meta's documentation shows them
 * (read 2026-10-11), with the placeholders (`<PAGE_ID>`, `<PSID>`) replaced by ids of the same
 * kind. Transcribed, not recorded: the adapters stay UNVERIFIED until real traffic is seen.
 *
 * - Messenger: Messenger Platform › Webhook events › messages (the text and attachment
 *   examples), message_deliveries and message_reads.
 * - Instagram: the Messenger API for Instagram's webhook (`object: "instagram"`, `entry[].id` the
 *   Instagram account, `messaging[]` with the IGSID as sender).
 * - WhatsApp: Cloud API › Webhooks › payload examples (the text message from Sheena Nelson, the
 *   delivered status) and the image message reference.
 */

export interface MessengerTextOptions {
  readonly pageId: string;
  readonly psid: string;
  readonly mid: string;
  readonly text: string;
  readonly timestamp?: number;
}

export function messengerText(options: MessengerTextOptions) {
  return {
    object: 'page',
    entry: [
      {
        id: options.pageId,
        time: 1583173667623,
        messaging: [
          {
            sender: { id: options.psid },
            recipient: { id: options.pageId },
            timestamp: options.timestamp ?? Date.now(),
            message: { mid: options.mid, text: options.text },
          },
        ],
      },
    ],
  };
}

export function messengerImage(options: Omit<MessengerTextOptions, 'text'> & { url: string }) {
  return {
    object: 'page',
    entry: [
      {
        id: options.pageId,
        time: 1583173667623,
        messaging: [
          {
            sender: { id: options.psid },
            recipient: { id: options.pageId },
            timestamp: options.timestamp ?? Date.now(),
            message: {
              mid: options.mid,
              attachments: [{ type: 'image', payload: { url: options.url } }],
            },
          },
        ],
      },
    ],
  };
}

export function messengerDelivery(options: {
  readonly pageId: string;
  readonly psid: string;
  readonly mids?: readonly string[];
  readonly watermark: number;
}) {
  return {
    object: 'page',
    entry: [
      {
        id: options.pageId,
        time: options.watermark + 10,
        messaging: [
          {
            sender: { id: options.psid },
            recipient: { id: options.pageId },
            delivery: {
              ...(options.mids === undefined ? {} : { mids: options.mids }),
              watermark: options.watermark,
            },
          },
        ],
      },
    ],
  };
}

export function messengerRead(options: {
  readonly pageId: string;
  readonly psid: string;
  readonly watermark: number;
}) {
  return {
    object: 'page',
    entry: [
      {
        id: options.pageId,
        time: options.watermark + 10,
        messaging: [
          {
            sender: { id: options.psid },
            recipient: { id: options.pageId },
            timestamp: options.watermark + 210,
            read: { watermark: options.watermark },
          },
        ],
      },
    ],
  };
}

export function instagramText(options: {
  readonly igAccountId: string;
  readonly igsid: string;
  readonly mid: string;
  readonly text: string;
  readonly timestamp?: number;
}) {
  return {
    object: 'instagram',
    entry: [
      {
        id: options.igAccountId,
        time: options.timestamp ?? Date.now(),
        messaging: [
          {
            sender: { id: options.igsid },
            recipient: { id: options.igAccountId },
            timestamp: options.timestamp ?? Date.now(),
            message: { mid: options.mid, text: options.text },
          },
        ],
      },
    ],
  };
}

export function whatsAppText(options: {
  readonly wabaId?: string;
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly name: string;
  readonly wamid: string;
  readonly text: string;
  /** Seconds, as a string, as Meta sends it. */
  readonly timestamp?: string;
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: options.wabaId ?? '102290129340398',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: options.phoneNumberId,
              },
              contacts: [{ profile: { name: options.name }, wa_id: options.waId }],
              messages: [
                {
                  from: options.waId,
                  id: options.wamid,
                  timestamp: options.timestamp ?? String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: options.text },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

export function whatsAppImage(options: {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly wamid: string;
  readonly caption: string;
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: options.phoneNumberId,
              },
              contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: options.waId }],
              messages: [
                {
                  from: options.waId,
                  id: options.wamid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'image',
                  image: {
                    caption: options.caption,
                    mime_type: 'image/jpeg',
                    sha256: 'SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=',
                    id: '1003383421387256',
                  },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

export function whatsAppStatus(options: {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly wamid: string;
  readonly status: string;
  readonly timestamp?: string;
  readonly errors?: readonly Record<string, unknown>[];
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: options.phoneNumberId,
              },
              statuses: [
                {
                  id: options.wamid,
                  status: options.status,
                  timestamp: options.timestamp ?? String(Math.floor(Date.now() / 1000)),
                  recipient_id: options.waId,
                  conversation: {
                    id: '9b8f1c0b1e6d2f3a4b5c6d7e8f901234',
                    origin: { type: 'service' },
                  },
                  pricing: { billable: true, pricing_model: 'CBP', category: 'service' },
                  ...(options.errors === undefined ? {} : { errors: options.errors }),
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}
