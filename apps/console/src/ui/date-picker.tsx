import {
  DatePicker as KitDatePicker,
  DateRangePicker as KitDateRangePicker,
  MonthPicker as KitMonthPicker,
  type DatePickerProps,
  type DateRange,
  type DateRangePickerProps,
  type MonthPickerProps,
  type RangePreset,
} from '@elysium/ui';

import { useLocale, useT } from '../i18n/locale.js';

/**
 * The kit's date pickers with the console's words and locale filled in (D-459), so a
 * screen writes `<DatePicker value onValueChange />` and nothing else. Business dates
 * stay `YYYY-MM-DD` strings in Dhaka's calendar.
 */

function useLabels() {
  const t = useT();
  return {
    previousMonth: t('common.previousMonth'),
    nextMonth: t('common.nextMonth'),
    today: t('common.today'),
    clear: t('common.clear'),
    month: t('common.month'),
    year: t('common.year'),
  };
}

export function DatePicker(
  props: Omit<DatePickerProps, 'locale' | 'labels'> & { readonly placeholder?: string },
) {
  const { locale } = useLocale();
  const t = useT();
  return (
    <KitDatePicker
      locale={locale}
      labels={useLabels()}
      {...props}
      placeholder={props.placeholder ?? t('common.pickDate')}
    />
  );
}

export function MonthPicker(props: Omit<MonthPickerProps, 'locale' | 'labels'>) {
  const { locale } = useLocale();
  const t = useT();
  return (
    <KitMonthPicker
      locale={locale}
      labels={{ previousYear: t('common.previousYear'), nextYear: t('common.nextYear') }}
      {...props}
      placeholder={props.placeholder ?? t('common.pickMonth')}
    />
  );
}

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** The periods people ask for most, ending today in Dhaka. */
export function usePeriodPresets(): readonly RangePreset[] {
  const t = useT();
  const now = today();
  const monthStart = `${now.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  return [
    { label: t('common.today'), range: { from: now, to: now } },
    { label: t('common.period.last7'), range: { from: addDays(now, -6), to: now } },
    { label: t('common.period.last30'), range: { from: addDays(now, -29), to: now } },
    { label: t('common.period.thisMonth'), range: { from: monthStart, to: now } },
    { label: t('common.period.lastMonth'), range: { from: lastMonthStart, to: lastMonthEnd } },
  ];
}

export function DateRangePicker(
  props: Omit<DateRangePickerProps, 'locale' | 'labels' | 'presets'> & {
    /** Off for a filter whose presets would not fit (a future period). */
    readonly withPresets?: boolean;
  },
) {
  const { locale } = useLocale();
  const t = useT();
  const presets = usePeriodPresets();
  const { withPresets = true, ...rest } = props;
  return (
    <KitDateRangePicker
      locale={locale}
      labels={useLabels()}
      presets={withPresets ? presets : []}
      {...rest}
      placeholder={props.placeholder ?? t('common.anyDate')}
    />
  );
}

export type { DateRange };
