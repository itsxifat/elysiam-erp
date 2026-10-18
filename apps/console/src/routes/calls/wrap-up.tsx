import { DateTime } from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ClipboardCheck } from 'lucide-react';
import { useState } from 'react';

import { useSession } from '../../auth/session.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { ordersPath } from '../orders/paths.js';
import { listWrapUps, WRAP_UPS_KEY } from './api.js';
import { DirectionMark, partyNumber, talkText, WrapUpForm } from './call-parts.js';
import { useTelT } from './messages.js';

const EVENTS = ['telephony.call_changed'] as const;

/**
 * The wrap-up card (D-859), on every screen for a person who places calls, desk phones included
 * (it does not depend on Envo's widget): after each of their calls it asks how it went, with the
 * ERP's suggestion picked and marked, what it was about, and a call-back time. It never saves by
 * itself; Later hides that call until the page is loaded again. The list comes from the server
 * (their own calls of the last day not yet wrapped up), loaded on start and again when one of
 * their calls changes. It never takes focus. Its own chunk, loaded from the work dock's.
 */
export function WrapUpCard() {
  const t = useTelT();
  const session = useSession();
  const me = session.context?.userId ?? null;
  const queryClient = useQueryClient();
  const [later, setLater] = useState<ReadonlySet<string>>(() => new Set());
  const [said, setSaid] = useState<string | null>(null);
  const wrapUps = useQuery({ queryKey: WRAP_UPS_KEY, queryFn: listWrapUps, staleTime: 30_000 });
  useRealtime({
    events: EVENTS,
    enabled: me !== null,
    onEvent: (_name, payload) => {
      const userIds = (payload as { userIds?: unknown } | null)?.userIds;
      if (Array.isArray(userIds) && me !== null && userIds.includes(me)) {
        void queryClient.invalidateQueries({ queryKey: WRAP_UPS_KEY });
      }
    },
  });
  const waiting = (wrapUps.data?.items ?? []).filter(
    (call) => call.canWrapUp && !later.has(call.id),
  );
  const call = waiting[0];

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
      {call === undefined ? null : (
        <section
          aria-label={t('tel.wrap.cardTitle')}
          className="fixed bottom-4 left-4 z-40 w-[calc(100vw-2rem)] max-w-sm space-y-2 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-popover"
          data-testid="wrap-up-card"
        >
          <header className="flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-1.5 font-medium">
              <ClipboardCheck aria-hidden="true" className="size-4 text-muted-foreground" />
              {t('tel.wrap.cardTitle')}
            </h2>
            {waiting.length > 1 ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('tel.wrap.waiting', { count: waiting.length })}
              </span>
            ) : null}
          </header>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            <DirectionMark call={call} />
            <span className="text-foreground">{call.customer?.name ?? partyNumber(call)}</span>
            {call.order === null ? null : (
              <Link
                to={ordersPath(`/orders/${call.order.id}`)}
                className="tabular-nums underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {call.order.orderNo}
              </Link>
            )}
            <DateTime value={call.endedAt ?? call.occurredAt} />
            <span className="tabular-nums">{talkText(call)}</span>
          </div>
          <WrapUpForm
            key={call.id}
            call={call}
            dismissLabel={t('tel.wrap.later')}
            onDismiss={() => setLater(new Set([...later, call.id]))}
            onDone={(orderAttempt) =>
              setSaid(
                call.order !== null && !orderAttempt
                  ? t('tel.wrap.savedNoAttempt')
                  : t('tel.wrap.saved'),
              )
            }
          />
        </section>
      )}
    </>
  );
}
