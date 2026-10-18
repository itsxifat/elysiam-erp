import { Button, cn } from '@elysium/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useOwnerGuard } from '../orders/owner-guard.js';
import { placeCall, TELEPHONY_KEY } from './api.js';
import { useTelT } from './messages.js';
import { expectRingBack } from './phone-store.js';

/**
 * Call a customer from your own extension (M47, D-834): Envo rings your phone, then dials them.
 *
 * Shown to the roles that place calls (`create PhoneCall`). About an order, the order page's
 * owner guard asks first when the order is someone else's (M41, D-710), and the server refuses
 * without the acknowledgement. The answer says your phone is ringing, or why not (no extension,
 * the connection switched off, Envo's own reason). The console's phone answers the ring-back by
 * itself when it is in this tab.
 */
export function CallButton({
  target,
  phone,
  label,
  size = 'sm',
  className,
}: {
  readonly target: {
    readonly orderId?: string;
    readonly customerId?: string;
    readonly phone?: string;
  };
  /** The number shown beside the button, for its accessible name and the ring-back. */
  readonly phone: string;
  /** Who is being called, for the phone's card (a name or an order number). */
  readonly label: string;
  readonly size?: 'sm' | 'icon';
  readonly className?: string;
}) {
  const t = useTelT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const { guard } = useOwnerGuard();
  const [said, setSaid] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | null>(
    null,
  );

  const call = useMutation({
    mutationFn: (acknowledge: boolean) => placeCall(target, acknowledge),
    onMutate: () => {
      expectRingBack(phone, label);
      setSaid(null);
    },
    onSuccess: () => setSaid({ tone: 'ok', text: t('tel.ringingYou') }),
    onError: (error) =>
      setSaid({ tone: 'error', text: error instanceof ApiError ? error.message : t('tel.failed') }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY }),
  });

  useEffect(() => {
    if (said?.tone !== 'ok') return;
    const timer = window.setTimeout(() => setSaid(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [said]);

  if (!ability.can('create', 'PhoneCall')) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <Button
        type="button"
        size={size === 'icon' ? 'icon-sm' : 'sm'}
        variant="outline"
        disabled={call.isPending}
        aria-label={t('tel.callAria', { phone })}
        onClick={() => guard((acknowledge) => call.mutate(acknowledge))}
      >
        <Phone aria-hidden="true" />
        {size === 'icon' ? null : call.isPending ? t('tel.calling') : t('tel.call')}
      </Button>
      {said === null ? null : (
        <span
          role={said.tone === 'error' ? 'alert' : 'status'}
          className={cn(
            'text-xs',
            said.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {said.text}
        </span>
      )}
    </span>
  );
}
