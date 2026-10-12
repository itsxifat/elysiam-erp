import type { Tx } from '@elysium/db';
import type { InboxChannelKind } from '@elysium/domain/inbox';

import { channelTokenBinding, openSecret } from './inbox-secrets.js';
import * as repo from './inbox.repository.js';

/**
 * Who sends on a conversation's channel, and with which token (M45; M42's rule, D-731): the
 * channel's own id and token, except Instagram, which goes through the Facebook Page linked to
 * it (the Page's id, and the Instagram channel's own token when one is set, else the Page's).
 * Null when the channel or its sender is switched off, or a token cannot be opened. The token is
 * never logged; it goes from here to the adapter's request and nowhere else.
 */
export interface ChannelSender {
  readonly senderId: string;
  readonly token: string;
}

export async function channelSender(
  tx: Tx,
  orgId: string,
  kind: InboxChannelKind,
  channelId: string,
): Promise<ChannelSender | null> {
  const channel = await repo.channelById(tx, orgId, channelId);
  const sender = kind === 'instagram' ? await repo.channelByKind(tx, orgId, 'messenger') : channel;
  const tokenRow = kind === 'instagram' && channel?.access_token_sealed != null ? channel : sender;
  if (channel?.enabled !== true || sender?.enabled !== true || tokenRow === undefined) return null;
  const token = openSecret(tokenRow.access_token_sealed, channelTokenBinding(orgId, tokenRow.kind));
  return token === null ? null : { senderId: sender.external_id, token };
}
