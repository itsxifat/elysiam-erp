import { Button, Money, takaToPoisha } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { listThresholds, setThreshold, type ThresholdRow } from './api.js';
import { isSettingsKey, useSettingsT } from './messages.js';
import {
  control,
  headClass,
  Loadable,
  messageOf,
  rowClass,
  SettingsPage,
  tableClass,
} from './parts.js';

/**
 * The brand's approval thresholds (§6, D-068, D-073; D-394).
 *
 * Under a type's threshold a request is approved at once; at or above it a second person
 * decides. Lowering applies immediately; raising (or a first threshold, which raises it from
 * "everything held") waits for a second org admin, and the screen shows the waiting value
 * beside the one in force rather than pretending the new one is already true. The types no
 * threshold can exempt (D-071) are listed apart, as "always a second person".
 */
export function ThresholdsPage() {
  const t = useSettingsT();
  const query = useQuery({ queryKey: ['settings', 'thresholds'], queryFn: listThresholds });
  return (
    <SettingsPage tab="/settings/thresholds">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('settings.thresholds.caption')}</p>
      <Loadable query={query}>
        {(data) => (
          <div className="space-y-4">
            <table className={tableClass}>
              <caption className="sr-only">{t('settings.nav.thresholds')}</caption>
              <thead>
                <tr className={headClass}>
                  <th className="py-1.5 font-medium">{t('settings.thresholds.colType')}</th>
                  <th className="py-1.5 text-right font-medium">
                    {t('settings.thresholds.colCurrent')}
                  </th>
                  <th className="py-1.5 text-right font-medium">
                    {t('settings.thresholds.colPending')}
                  </th>
                  <th className="py-1.5 pl-4 font-medium">{t('settings.thresholds.colNew')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <ThresholdLine key={row.type} row={row} />
                ))}
              </tbody>
            </table>
            <section className="space-y-1">
              <h2 className="text-sm font-medium">{t('settings.thresholds.alwaysHeld')}</h2>
              <p className="text-sm text-muted-foreground">
                {data.alwaysHeld.map((type) => typeLabel(t, type)).join(' · ')}
              </p>
            </section>
          </div>
        )}
      </Loadable>
    </SettingsPage>
  );
}

function typeLabel(t: ReturnType<typeof useSettingsT>, type: string): string {
  const key = `approvals.type.${type}`;
  return isSettingsKey(key) ? t(key) : type;
}

function ThresholdLine({ row }: { readonly row: ThresholdRow }) {
  const t = useSettingsT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const id = `threshold-${row.type}`;

  const save = useMutation({
    mutationFn: (poisha: string) => setThreshold(row.type, poisha),
    onSuccess: async (result) => {
      setValue('');
      setNotice({
        text:
          result.status === 'applied'
            ? t('settings.thresholds.applied')
            : t('settings.thresholds.sentForApproval'),
        error: false,
      });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'thresholds'] });
    },
    onError: (error) =>
      setNotice({ text: messageOf(error, t('settings.errorDetail')), error: true }),
  });

  const mayUpdate = ability.can('update', 'ApprovalThreshold');

  return (
    <tr className={rowClass}>
      <td className="py-1.5">{typeLabel(t, row.type)}</td>
      <td className="py-1.5 text-right">
        {row.thresholdPoisha === null ? (
          <span className="text-muted-foreground">{t('settings.thresholds.none')}</span>
        ) : (
          <Money poisha={row.thresholdPoisha} locale={locale} />
        )}
      </td>
      <td className="py-1.5 text-right">
        {row.pending.length === 0
          ? '—'
          : row.pending.map((entry) => (
              <Money key={entry.approvalId} poisha={entry.thresholdPoisha} locale={locale} />
            ))}
      </td>
      <td className="py-1.5 pl-4">
        {mayUpdate ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const poisha = takaToPoisha(value);
              if (poisha === null || poisha.startsWith('-')) {
                setNotice({ text: t('settings.thresholds.invalid'), error: true });
                return;
              }
              save.mutate(poisha);
            }}
          >
            <label htmlFor={id} className="sr-only">
              {`${t('settings.thresholds.colNew')} — ${typeLabel(t, row.type)}`}
            </label>
            <input
              id={id}
              inputMode="decimal"
              value={value}
              className={`${control.replace('w-full', 'w-32')} tabular-nums`}
              onChange={(event) => setValue(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={save.isPending}>
              {t('settings.thresholds.set')}
            </Button>
            {notice === null ? null : (
              <span
                role={notice.error ? 'alert' : 'status'}
                className={
                  notice.error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                }
              >
                {notice.text}
              </span>
            )}
          </form>
        ) : null}
      </td>
    </tr>
  );
}
