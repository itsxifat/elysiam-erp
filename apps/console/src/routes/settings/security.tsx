import type { MembershipRole } from '@elysium/contracts';
import { formatCount } from '@elysium/i18n';
import { Button, ConfirmDialog, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../../api.js';
import { useLocale } from '../../i18n/locale.js';
import { useAccountT } from '../account/messages.js';
import { refusalText } from '../account/logic.js';
import { headClass, Loadable, rowClass, SettingsPage, tableClass } from './parts.js';

/**
 * Settings → Security (M40, D-691, D-692): one switch per role for "two-step sign-in is
 * required". Super admins are always required, shown and never switched. Saving a role on that
 * has people without a factor asks first, with the count, because they are walled at their next
 * click; switching a role off removes nobody's factor. Only a super admin opens this tab (the
 * tab and both routes ask `SecurityPolicy`, which no role holds).
 */

interface PolicyRole {
  readonly role: MembershipRole;
  readonly required: boolean;
  readonly byDefault: boolean;
  readonly members: number;
  readonly withoutTwoFactor: number;
}

interface Policy {
  readonly roles: readonly PolicyRole[];
  readonly superAdminsAlways: true;
  readonly isDefault: boolean;
  readonly newlyWalled?: number;
}

const POLICY_KEY = ['settings', 'security'] as const;

const getPolicy = () => api.get<Policy>('/v1/security/two-factor-policy');
const savePolicy = (requiredRoles: readonly MembershipRole[]) =>
  api.put<Policy>('/v1/security/two-factor-policy', { requiredRoles });

const SWITCH =
  'size-4 shrink-0 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50';

/** The people a save would wall: in roles switched on now, with no factor yet. */
export function wouldWall(policy: Policy, chosen: ReadonlySet<MembershipRole>): number {
  return policy.roles
    .filter((entry) => !entry.required && chosen.has(entry.role))
    .reduce((sum, entry) => sum + entry.withoutTwoFactor, 0);
}

export function SecurityPage() {
  const t = useAccountT();
  const query = useQuery({ queryKey: POLICY_KEY, queryFn: getPolicy });
  return (
    <SettingsPage tab="/settings/security">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('settings.security.caption')}</p>
      <Loadable query={query}>{(policy) => <PolicyTable policy={policy} />}</Loadable>
    </SettingsPage>
  );
}

function PolicyTable({ policy }: { readonly policy: Policy }) {
  const t = useAccountT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const saved = new Set(policy.roles.filter((entry) => entry.required).map((entry) => entry.role));
  const [chosen, setChosen] = useState<ReadonlySet<MembershipRole>>(saved);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const changed = chosen.size !== saved.size || [...chosen].some((role) => !saved.has(role));
  const walls = wouldWall(policy, chosen);

  const save = useMutation({
    mutationFn: () =>
      savePolicy(policy.roles.map((entry) => entry.role).filter((role) => chosen.has(role))),
    onSuccess: async (result) => {
      const walled = result.newlyWalled ?? 0;
      setMessage({
        tone: 'ok',
        text:
          walled > 0
            ? t('settings.security.savedWalled', { n: formatCount(walled, locale) })
            : t('settings.security.saved'),
      });
      await queryClient.invalidateQueries({ queryKey: POLICY_KEY });
      // The Staff list's "required" column reads the same setting.
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (cause) => setMessage({ tone: 'error', text: refusalText(cause, t) }),
  });

  const toggle = (role: MembershipRole, on: boolean) => {
    setMessage(null);
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(role);
      else next.delete(role);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <table className={tableClass}>
        <caption className="sr-only">{t('settings.security.colRequired')}</caption>
        <thead>
          <tr className={headClass}>
            <th scope="col" className="py-1.5 font-medium">
              {t('settings.security.colRole')}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {t('settings.security.colRequired')}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              {t('settings.security.colPeople')}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              {t('settings.security.colWithout')}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className={rowClass}>
            <td className="py-2 font-medium">{t('settings.security.superAdmins')}</td>
            <td className="py-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" className={SWITCH} checked disabled />
                {t('settings.security.always')}
              </label>
            </td>
            <td className="py-2 text-right text-muted-foreground">—</td>
            <td className="py-2 text-right text-muted-foreground">—</td>
          </tr>
          {policy.roles.map((entry) => {
            const id = `require-${entry.role}`;
            return (
              <tr key={entry.role} className={rowClass}>
                <td className="py-2">
                  <label htmlFor={id} className="flex items-center gap-2 font-medium">
                    {t(`users.role.${entry.role}`)}
                    {entry.byDefault ? (
                      <StatusBadge tone="neutral">{t('settings.security.byDefault')}</StatusBadge>
                    ) : null}
                  </label>
                </td>
                <td className="py-2">
                  <input
                    id={id}
                    type="checkbox"
                    className={SWITCH}
                    checked={chosen.has(entry.role)}
                    disabled={save.isPending}
                    onChange={(event) => toggle(entry.role, event.target.checked)}
                  />
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCount(entry.members, locale)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {entry.withoutTwoFactor === 0 ? (
                    <span className="text-muted-foreground">{formatCount(0, locale)}</span>
                  ) : (
                    formatCount(entry.withoutTwoFactor, locale)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {message === null ? null : (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'
          }
        >
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!changed || save.isPending}
          onClick={() => {
            if (walls > 0) setConfirming(true);
            else save.mutate();
          }}
        >
          {t('settings.security.save')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!changed || save.isPending}
          onClick={() => {
            setMessage(null);
            setChosen(saved);
          }}
        >
          {t('settings.security.reset')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('settings.security.confirmTitle')}
        description={t('settings.security.confirmDetail', { n: formatCount(walls, locale) })}
        confirmLabel={t('settings.security.confirm')}
        cancelLabel={t('account.cancel')}
        closeLabel={t('account.close')}
        onConfirm={async () => {
          await save.mutateAsync().catch(() => undefined);
        }}
      />
    </div>
  );
}
