import { workflowSettingsSchema } from '@elysium/contracts';
import { Button, controlClassName } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import {
  getWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
} from '../orders/workflow-api.js';
import { Loadable, SettingsPage } from './parts.js';

/**
 * Settings → Order workflow (M41, D-715): auto-assign on or off (off until the brand turns it
 * on), how long an offer waits for an answer, and the most open orders one person holds before
 * they are offered no more. The org admin changes it; a branch manager reads it.
 */

const SETTINGS_KEY = ['orders', 'workflow-settings'] as const;

export function WorkflowSettingsPage() {
  const query = useQuery({ queryKey: SETTINGS_KEY, queryFn: getWorkflowSettings });
  const t = useT();
  return (
    <SettingsPage tab="/settings/order-workflow">
      <div className="max-w-2xl space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{t('wf.settings.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('wf.settings.subtitle')}</p>
      </div>
      <Loadable query={query}>{(settings) => <WorkflowForm settings={settings} />}</Loadable>
    </SettingsPage>
  );
}

function WorkflowForm({ settings }: { readonly settings: WorkflowSettings }) {
  const t = useT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayEdit = ability.can('update', 'OrderWorkflow');
  const [autoAssign, setAutoAssign] = useState(settings.autoAssign);
  const [offerSeconds, setOfferSeconds] = useState(String(settings.offerSeconds));
  const [maxOpen, setMaxOpen] = useState(String(settings.maxOpen));
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const save = useMutation({
    mutationFn: (input: WorkflowSettings) => saveWorkflowSettings(input),
    onSuccess: async () => {
      setMessage({ tone: 'ok', text: t('wf.saved') });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) =>
      setMessage({
        tone: 'error',
        text: error instanceof ApiError ? error.message : t('wf.failed'),
      }),
  });

  return (
    <form
      className="max-w-2xl space-y-5 rounded-lg border border-border bg-card p-5"
      data-testid="workflow-settings"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = workflowSettingsSchema.safeParse({
          autoAssign,
          offerSeconds: Number(offerSeconds),
          maxOpen: Number(maxOpen),
        });
        if (!parsed.success) {
          setMessage({ tone: 'error', text: parsed.error.issues[0]?.message ?? t('wf.failed') });
          return;
        }
        save.mutate(parsed.data);
      }}
    >
      <label className="flex items-start gap-3 text-sm" htmlFor={`${id}-auto`}>
        <input
          id={`${id}-auto`}
          type="checkbox"
          checked={autoAssign}
          disabled={!mayEdit}
          className="mt-0.5 size-4 shrink-0 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          onChange={(event) => setAutoAssign(event.target.checked)}
        />
        <span className="space-y-0.5">
          <span className="block font-medium">{t('wf.settings.autoAssign')}</span>
          <span className="block text-muted-foreground">{t('wf.settings.autoAssignHint')}</span>
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm" htmlFor={`${id}-seconds`}>
          <span className="font-medium">{t('wf.settings.offerSeconds')}</span>
          <input
            id={`${id}-seconds`}
            inputMode="numeric"
            value={offerSeconds}
            disabled={!mayEdit}
            aria-describedby={`${id}-seconds-hint`}
            className={`${controlClassName} w-full tabular-nums`}
            onChange={(event) => setOfferSeconds(event.target.value)}
          />
          <span id={`${id}-seconds-hint`} className="block text-xs text-muted-foreground">
            {t('wf.settings.offerSecondsHint')}
          </span>
        </label>
        <label className="block space-y-1.5 text-sm" htmlFor={`${id}-max`}>
          <span className="font-medium">{t('wf.settings.maxOpen')}</span>
          <input
            id={`${id}-max`}
            inputMode="numeric"
            value={maxOpen}
            disabled={!mayEdit}
            aria-describedby={`${id}-max-hint`}
            className={`${controlClassName} w-full tabular-nums`}
            onChange={(event) => setMaxOpen(event.target.value)}
          />
          <span id={`${id}-max-hint`} className="block text-xs text-muted-foreground">
            {t('wf.settings.maxOpenHint')}
          </span>
        </label>
      </div>
      {mayEdit ? (
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('wf.saving') : t('wf.save')}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t('wf.settings.denied')}</p>
      )}
      {message === null ? null : (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={message.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-success'}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
