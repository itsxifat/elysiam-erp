import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect } from 'react';

import { useLocale } from '../i18n/locale.js';
import '../i18n/alive.js';
import { getThread, getUnread, INBOX_KEY } from '../routes/inbox/api.js';
import { fill } from '../routes/inbox/logic.js';
import { messageConcerns } from './concerns.js';
import { alertIfHidden } from './notify.js';
import { setTitleCount } from './title.js';
import { playTone } from './tones.js';

/**
 * The inbox's voice anywhere in the console (M44a, D-764, D-766), run by the shell's work dock
 * so it is heard on every screen, not only on the inbox:
 *
 * - a customer's new message rings for the person whose conversation it is, and for everyone
 *   whose desk takes messages while nobody has it; the brand's own echoes never ring;
 * - while the tab is hidden, a desktop alert names who wrote and what (fetched over REST, where
 *   the server decides what this person may read; the socket carries ids only, §19);
 * - the tab's title counts the unread messages that are theirs to answer.
 */

export interface InboxAlertsOptions {
  readonly enabled: boolean;
  readonly me: string | null;
  /** Their desk takes messages: conversations nobody has are theirs to pick up too. */
  readonly takesMessages: boolean;
}

const CHANNEL_KEYS = {
  messenger: 'alive.channel.messenger',
  instagram: 'alive.channel.instagram',
  whatsapp: 'alive.channel.whatsapp',
} as const;

export function useInboxAlerts({ enabled, me, takesMessages }: InboxAlertsOptions) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const unread = useQuery({
    queryKey: [...INBOX_KEY, 'unread'],
    queryFn: getUnread,
    enabled,
    // A safety net while the socket reconnects; events invalidate it the rest of the time.
    refetchInterval: 60_000,
  });
  const count = enabled
    ? (unread.data?.mine ?? 0) + (takesMessages ? (unread.data?.unassigned ?? 0) : 0)
    : 0;

  useEffect(() => {
    setTitleCount(count);
  }, [count]);
  useEffect(() => () => setTitleCount(0), []);

  const onMessage = useCallback(
    (payload: unknown) => {
      if (!enabled) return;
      void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'unread'] });
      const concern = messageConcerns(payload, me, takesMessages);
      if (concern === null) return;
      playTone('message');
      if (document.visibilityState !== 'hidden') return;
      const key = CHANNEL_KEYS[concern.channel as keyof typeof CHANNEL_KEYS] as
        (typeof CHANNEL_KEYS)[keyof typeof CHANNEL_KEYS] | undefined;
      const channel = key === undefined ? concern.channel : t(key);
      void getThread(concern.conversationId, 1)
        .then((thread) => {
          const name = thread.conversation.contact.name ?? t('alive.notify.someone');
          alertIfHidden({
            title: fill(t('alive.notify.messageFrom'), { name, channel }),
            body: thread.conversation.lastPreview ?? '',
            tag: `inbox:${concern.conversationId}`,
            onClick: () =>
              void navigate({ to: '/inbox', search: { c: concern.conversationId } as never }),
          });
        })
        .catch(() =>
          alertIfHidden({
            title: fill(t('alive.notify.message'), { channel }),
            tag: `inbox:${concern.conversationId}`,
          }),
        );
    },
    [enabled, me, takesMessages, queryClient, navigate, t],
  );

  return { onMessage, unread: count };
}
