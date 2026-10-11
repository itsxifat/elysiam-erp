import { Button, Select } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import { listLocations } from '../courier/api.js';
import { listDeskProfiles, saveDeskProfile, type DeskProfile } from '../orders/workflow-api.js';

/**
 * A staff member's desk profile on the Staff screen (M41, D-714): the work they may be offered
 * (orders, messages) and the hub location they pack at. Saved on its own, beside the roles,
 * by whoever may change the person (`update User`).
 */

const WORK_TYPES = ['orders', 'messages'] as const;

const BOX =
  'size-4 shrink-0 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50';

export function DeskSection({
  userId,
  locked,
}: {
  readonly userId: string;
  readonly locked: boolean;
}) {
  const ability = useAbility();
  const profiles = useQuery({ queryKey: ['team', 'profiles'], queryFn: listDeskProfiles });
  const profile = profiles.data?.items.find((entry) => entry.userId === userId);
  if (!ability.can('update', 'User') || profile === undefined) return null;
  return (
    <DeskForm
      key={`${profile.userId}:${profile.workTypes.join(',')}`}
      profile={profile}
      locked={locked}
    />
  );
}

function DeskForm({
  profile,
  locked,
}: {
  readonly profile: DeskProfile;
  readonly locked: boolean;
}) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const locations = useQuery({ queryKey: ['inventory', 'locations'], queryFn: listLocations });
  const [types, setTypes] = useState<ReadonlySet<string>>(new Set(profile.workTypes));
  const [hub, setHub] = useState(profile.hubLocationId ?? '');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const save = useMutation({
    mutationFn: () =>
      saveDeskProfile(profile.userId, {
        workTypes: WORK_TYPES.filter((type) => types.has(type)),
        hubLocationId: hub === '' ? null : hub,
      }),
    onSuccess: async () => {
      setMessage({ tone: 'ok', text: t('wf.saved') });
      await queryClient.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (error) =>
      setMessage({
        tone: 'error',
        text: error instanceof ApiError ? error.message : t('wf.failed'),
      }),
  });

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 border-t border-border pt-4"
      data-testid="desk-profile"
    >
      <div>
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {t('wf.profile.title')}
          {profile.defaultProfile ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t('wf.profile.default')}
            </span>
          ) : null}
        </h3>
        <p className="text-xs text-muted-foreground">{t('wf.profile.detail')}</p>
      </div>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1.5 text-sm font-medium">{t('wf.profile.workTypes')}</legend>
        {WORK_TYPES.map((type) => (
          <label key={type} className="flex items-center gap-2 text-sm" htmlFor={`${id}-${type}`}>
            <input
              id={`${id}-${type}`}
              type="checkbox"
              className={BOX}
              disabled={locked}
              checked={types.has(type)}
              onChange={(event) =>
                setTypes((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(type);
                  else next.delete(type);
                  return next;
                })
              }
            />
            {type === 'orders' ? t('wf.profile.orders') : t('wf.profile.messages')}
          </label>
        ))}
      </fieldset>
      <label className="block space-y-1.5 text-sm" htmlFor={`${id}-hub`}>
        <span className="font-medium">{t('wf.profile.hub')}</span>
        <Select
          id={`${id}-hub`}
          value={hub}
          disabled={locked}
          onValueChange={setHub}
          options={[
            { value: '', label: t('wf.profile.noHub') },
            ...(locations.data?.items ?? [])
              .filter((place) => place.isActive && ['warehouse', 'showroom'].includes(place.kind))
              .map((place) => ({ value: place.id, label: place.name })),
          ]}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={locked || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? t('wf.saving') : t('wf.save')}
        </Button>
        {message === null ? null : (
          <span
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={
              message.tone === 'error'
                ? 'text-sm text-destructive'
                : 'text-sm text-muted-foreground'
            }
          >
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}
