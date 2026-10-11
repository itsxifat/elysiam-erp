import type { InboxChannelKindName, InboxContactStage } from '@elysium/contracts';
import { z } from 'zod';

/**
 * The inbox's address bar (M42): the list's filters and the open conversation, so a filtered
 * inbox is shareable and Back works. A hand-edited value falls back to the default view.
 *
 * Its own small module, because the router imports it in the first download: the lists are
 * written out here (and held to the contracts' by the types below) rather than imported with
 * the rest of the inbox's contracts, which travel in the inbox's own chunk.
 */
const CHANNELS = [
  'messenger',
  'instagram',
  'whatsapp',
] as const satisfies readonly InboxChannelKindName[];
const STAGES = [
  'visitor',
  'lead',
  'customer',
  'not_qualified',
  'fraud',
] as const satisfies readonly InboxContactStage[];

// Every value the contracts name is listed: a new channel or stage fails to compile here.
type Missing<TAll, TListed> = Exclude<TAll, TListed>;
const everyChannel: Missing<InboxChannelKindName, (typeof CHANNELS)[number]> extends never
  ? true
  : false = true;
const everyStage: Missing<InboxContactStage, (typeof STAGES)[number]> extends never ? true : false =
  true;
void everyChannel;
void everyStage;

export const inboxSearchSchema = z.object({
  view: z.enum(['all', 'mine', 'unassigned']).catch('all').default('all'),
  channel: z.enum(CHANNELS).optional().catch(undefined),
  stage: z.enum(STAGES).optional().catch(undefined),
  unread: z.boolean().optional().catch(undefined),
  closed: z.boolean().optional().catch(undefined),
  q: z.string().max(64).optional().catch(undefined),
  c: z.string().uuid().optional().catch(undefined),
});
export type InboxSearch = z.infer<typeof inboxSearchSchema>;
