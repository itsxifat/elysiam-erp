import { Button, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CirclePause, CirclePlay } from 'lucide-react';

import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import { myDesk, setPaused, type PresenceState } from './workflow-api.js';

/**
 * Your status at the desk, and the "Not taking orders" switch (M41, D-713), in the sales desk's
 * header: where a person who takes orders works, and out of the way of every other screen.
 * The heartbeat itself runs in the shell's work dock.
 */

const STATE_TONE: Readonly<Record<PresenceState, 'success' | 'warning' | 'neutral'>> = {
  active: 'success',
  idle: 'warning',
  away: 'neutral',
};

export function PresenceControl() {
  const t = useT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const allowed = ability.can('update', 'Presence');
  const desk = useQuery({ queryKey: ['team', 'me'], queryFn: myDesk, enabled: allowed });
  const pause = useMutation({
    mutationFn: (paused: boolean) => setPaused(paused),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['team', 'me'] });
    },
  });

  const presence = desk.data?.presence;
  if (!allowed || presence === undefined || (desk.data?.profile.workTypes.length ?? 0) === 0) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="presence-control">
      <span className="sr-only">{t('wf.status.yours')}:</span>
      <StatusBadge tone={STATE_TONE[presence.state]}>
        {t(`wf.status.${presence.state}`)}
      </StatusBadge>
      <span data-testid="taking-orders">
        {presence.paused ? t('wf.status.paused') : t('wf.status.taking')}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={pause.isPending}
        onClick={() => pause.mutate(!presence.paused)}
      >
        {presence.paused ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
        {presence.paused ? t('wf.status.resume') : t('wf.status.pause')}
      </Button>
    </div>
  );
}
