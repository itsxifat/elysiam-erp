import { z } from 'zod';

import { DEFAULT_PAGE_SIZE, tableSearchSchema } from '../../lib/table-search.js';
import { ORDER_CHANNELS, ORDER_STATUSES } from './api.js';

/**
 * The order list's and the buyer list's filters, as URL search params (M11 Build list:
 * "filters: status, channel, date, agent, zone").
 *
 * In the URL for M05's reason — "the unassigned WhatsApp orders from yesterday" is a link an
 * agent pastes into a chat — and validated with `.catch` on every field for M05's other
 * reason: a hand-edited address must fall back to the default view, not blow up the screen.
 *
 * `agent` carries three kinds of value: a user id, or the two queue words `unassigned` and
 * `mine`, which the server knows as `queue=`. One parameter because it is one control.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .refine((value) => value !== '')
    .optional()
    .catch(undefined);

export const orderListSearchSchema = tableSearchSchema.extend({
  status: z.enum(ORDER_STATUSES).optional().catch(undefined),
  channel: z.enum(ORDER_CHANNELS).optional().catch(undefined),
  agent: optionalText(64),
  zone: z.string().uuid().optional().catch(undefined),
  from: isoDate,
  to: isoDate,
});

export type OrderListSearch = z.infer<typeof orderListSearchSchema>;

export const DEFAULT_ORDER_SEARCH: OrderListSearch = { page: 1, pageSize: DEFAULT_PAGE_SIZE };

/** Merge a change, dropping emptied filters and resetting the page on any filter change. */
export function mergeOrderSearch(
  current: OrderListSearch,
  patch: Partial<OrderListSearch>,
): OrderListSearch {
  const filterChanged = Object.keys(patch).some(
    (key) =>
      key !== 'page' &&
      patch[key as keyof OrderListSearch] !== current[key as keyof OrderListSearch],
  );
  const next: Record<string, unknown> = {
    ...current,
    ...patch,
    ...(filterChanged && patch.page === undefined ? { page: 1 } : {}),
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === '') delete next[key];
  }
  return orderListSearchSchema.parse(next);
}

export const buyerSearchSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
  product: optionalText(120),
  sku: optionalText(64),
  size: optionalText(8),
  channel: z.enum(ORDER_CHANNELS).optional().catch(undefined),
  from: isoDate,
  to: isoDate,
});

export type BuyerSearch = z.infer<typeof buyerSearchSchema>;

export const BUYER_PAGE_SIZE = 50;

/**
 * The order desk's own search (M42, D-742): the inbox conversation an order is being taken
 * from, so the form starts from the chat. Only the id: the phone, name and address are fetched,
 * never carried in the address bar.
 */
export const deskSearchSchema = z.object({
  conversation: z.string().uuid().optional().catch(undefined),
});
