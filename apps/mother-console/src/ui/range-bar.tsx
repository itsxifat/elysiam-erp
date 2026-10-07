import { addDays } from '@elysium/domain';
import { cn, DateRangePicker, type DateRange as PickerRange } from '@elysium/ui';
import { presetRange, type DateRange, type RangePreset } from '@elysium/mother-shared';

import { useLocale, type MessageKey } from '../i18n/locale.js';
import { presetOf, todayInDhaka } from './range.js';

/**
 * One row above the figures (the dataviz rule: filters first, one row, scoping everything
 * below): today, this week, this month, or any period from the kit's range picker.
 */

const PRESETS: readonly { readonly preset: RangePreset; readonly label: MessageKey }[] = [
  { preset: 'today', label: 'range.today' },
  { preset: 'week', label: 'range.week' },
  { preset: 'month', label: 'range.month' },
];

export function RangeBar({
  value,
  onChange,
}: {
  readonly value: DateRange;
  readonly onChange: (range: DateRange) => void;
}) {
  const { t, locale } = useLocale();
  const active = presetOf(value);
  const today = todayInDhaka();

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('range.label')}>
      <div className="inline-flex rounded-md border border-input bg-background p-0.5">
        {PRESETS.map(({ preset, label }) => (
          <button
            key={preset}
            type="button"
            aria-pressed={active === preset}
            onClick={() => onChange(presetRange(preset, today))}
            className={cn(
              'h-control-sm rounded-sm px-3 text-sm text-muted-foreground',
              'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              active === preset && 'bg-selected font-medium text-selected-foreground',
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <DateRangePicker
        value={{ from: value.from, to: value.to }}
        onValueChange={(next: PickerRange) => {
          if (next.from !== '' && next.to !== '') {
            onChange({ from: next.from, to: next.to } as DateRange);
          }
        }}
        locale={locale}
        max={today}
        size="sm"
        aria-label={t('range.label')}
        labels={{
          previousMonth: t('picker.previousMonth'),
          nextMonth: t('picker.nextMonth'),
          today: t('picker.today'),
          clear: t('picker.clear'),
        }}
        presets={[{ label: t('range.last30'), range: { from: addDays(today, -29), to: today } }]}
      />
    </div>
  );
}
