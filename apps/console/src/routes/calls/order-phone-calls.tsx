import { Button, DateTime, Skeleton } from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PanelRightOpen } from 'lucide-react';

import { useAbility } from '../../auth/session.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { listCalls, TELEPHONY_KEY } from './api.js';
import { CallButton } from './call-button.js';
import { CallState, DirectionMark, talkText, WrapUpCell } from './call-parts.js';
import { openCallerPanel } from './caller-panel-store.js';
import { useTelT } from './messages.js';
import { RecordingPlayer } from './recording-player.js';

const EVENTS = ['telephony.call_changed'] as const;

/**
 * An order's phone calls through Envo (M47, D-838), inside M41's verification calls: a Call
 * button for the recipient (the number shown is the one dialled), and each call Envo reported
 * about the order (who, when, answered or missed, talk time, the recording) with its wrap-up
 * (D-859): what was written, or Wrap up for the viewer's own ended call, which also logs M41's
 * attempt while the order can still be called about. Lists only the calls the viewer may see
 * (D-841). Loaded with the order page's chunk.
 */
export function OrderPhoneCalls({
  orderId,
  orderNo,
  phone,
  callable,
}: {
  readonly orderId: string;
  readonly orderNo: string;
  readonly phone: string;
  /** Whether M41 still takes verification attempts for this order (pending, on hold, confirmed). */
  readonly callable: boolean;
}) {
  const t = useTelT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayRead = ability.can('read', 'PhoneCall');
  const calls = useQuery({
    queryKey: [...TELEPHONY_KEY, 'order', orderId],
    queryFn: () => listCalls({ orderId, limit: 20 }),
    enabled: mayRead,
  });
  useRealtime({
    events: EVENTS,
    enabled: mayRead,
    onEvent: (_name, payload) => {
      if ((payload as { orderId?: unknown } | null)?.orderId === orderId) {
        void queryClient.invalidateQueries({ queryKey: [...TELEPHONY_KEY, 'order', orderId] });
      }
    },
  });
  if (!mayRead && !ability.can('create', 'PhoneCall')) return null;
  const items = calls.data?.items ?? [];

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="order-phone-calls">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('tel.order.title')}</h3>
        {/* The number shown is the one dialled: the recipient M41 verifies (as the header does). */}
        <CallButton target={{ orderId, phone }} phone={phone} label={orderNo} />
      </div>
      {calls.isPending && mayRead ? (
        <Skeleton className="h-10 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('tel.order.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((call) => (
            <li key={call.id} className="space-y-1.5 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <DirectionMark call={call} />
                <CallState call={call} />
                <span className="text-muted-foreground tabular-nums">{talkText(call)}</span>
                <span className="text-muted-foreground">
                  <DateTime value={call.occurredAt} />
                </span>
                {call.person === null ? null : (
                  <span className="text-muted-foreground">{call.person.name ?? ''}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <RecordingPlayer call={call} />
                {/* M47 (D-860): everything about whom the call was with. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openCallerPanel({ callId: call.id })}
                >
                  <PanelRightOpen aria-hidden="true" />
                  {t('tel.panel.details')}
                </Button>
              </div>
              <WrapUpCell call={call} orderCallable={callable} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
