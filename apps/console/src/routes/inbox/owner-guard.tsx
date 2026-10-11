import { ConfirmDialog } from '@elysium/ui';
import { useCallback, useState, type ReactNode } from 'react';

import { isAckRequired, ownerToAcknowledge } from './logic.js';
import type { ConversationItem } from './api.js';
import { useInboxT } from './messages.js';

/**
 * Acknowledging a conversation's owner before acting in it (M42, D-737).
 *
 * `guard(action)` runs `action(false)` at once on a conversation that is mine or nobody's. On
 * someone else's it first asks — "This conversation is Rahim's. Act anyway? Rahim will be told."
 * — and runs `action(true)`, which sends `x-acknowledge-owner: 1`, only on yes. If the server
 * says someone took it in the meantime (`INBOX_OWNER_ACK_REQUIRED`), the same question is asked
 * then. The server is the check; this only makes the question the person sees.
 */
export function useOwnerGuard(
  conversation: Pick<ConversationItem, 'assignedTo'> | undefined,
  me: string | null,
): {
  readonly guard: (action: (acknowledged: boolean) => Promise<unknown>) => Promise<void>;
  readonly dialog: ReactNode;
} {
  const t = useInboxT();
  const [pending, setPending] = useState<{
    readonly name: string;
    readonly run: () => Promise<unknown>;
  } | null>(null);

  const guard = useCallback(
    async (action: (acknowledged: boolean) => Promise<unknown>) => {
      const owner = conversation === undefined ? null : ownerToAcknowledge(conversation, me);
      if (owner !== null) {
        setPending({ name: owner.name ?? t('inbox.someone'), run: () => action(true) });
        return;
      }
      try {
        await action(false);
      } catch (error) {
        if (!isAckRequired(error)) throw error;
        setPending({ name: t('inbox.someone'), run: () => action(true) });
      }
    },
    // `t` is a fresh closure each render; the strings it reads do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversation, me],
  );

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={t('inbox.ack.title', { name: pending?.name ?? '' })}
      description={t('inbox.ack.detail', { name: pending?.name ?? '' })}
      confirmLabel={t('inbox.ack.confirm')}
      cancelLabel={t('inbox.cancel')}
      closeLabel={t('inbox.cancel')}
      onConfirm={async () => {
        const run = pending?.run;
        setPending(null);
        // The action's own mutation shows a failure; nothing more to do here.
        if (run !== undefined) await run().catch(() => undefined);
      }}
    />
  );

  return { guard, dialog };
}
