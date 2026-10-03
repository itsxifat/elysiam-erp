import * as PopoverPrimitive from '@radix-ui/react-popover';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { controlClassName } from './input.js';
import { Select } from './select.js';
import { cn } from '../lib/cn.js';

/**
 * The date pickers (D-459): one business date, a month, or a period with presets.
 *
 * They replace the browser's `type="date"` and `type="month"` controls, which drew a
 * US-ordered `mm/dd/yyyy` in a grey OS widget on a screen that is otherwise the kit's.
 * A business date stays what it was: a `YYYY-MM-DD` string in Asia/Dhaka's calendar
 * (invariant 8), never an instant. The arithmetic below is on UTC calendar days, so no
 * zone can move a date by one, and a month is `YYYY-MM`.
 *
 * Month and weekday names come from `Intl`, in the caller's locale, so Bangla gets
 * Bangla months and digits without a string table here. The few words that are not
 * names (previous month, today, clear, the presets) come from the caller as labels.
 *
 * Keyboard: the trigger opens the calendar; arrows move a day or a week, Page Up and
 * Page Down a month, Home and End the week, Enter picks, Escape closes and returns
 * focus to the trigger (Radix).
 */

export type PickerLocale = 'en' | 'bn';

export interface DatePickerLabels {
  readonly previousMonth: string;
  readonly nextMonth: string;
  readonly today: string;
  readonly clear: string;
  /** Names for the month and year lists, when the calendar offers them (`years`). */
  readonly month?: string;
  readonly year?: string;
}

/** The years a calendar's year list offers: a birthday needs decades, a filter does not. */
export interface YearSpan {
  readonly from: number;
  readonly to: number;
}

const INTL: Record<PickerLocale, string> = { en: 'en-GB', bn: 'bn-BD' };

// --- calendar arithmetic, on UTC days ---------------------------------------------

interface Day {
  readonly y: number;
  readonly m: number; // 0-11
  readonly d: number;
}

function parseDay(value: string): Day | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}

function toIso(day: Day): string {
  return `${String(day.y).padStart(4, '0')}-${String(day.m + 1).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
}

function utc(day: Day): Date {
  return new Date(Date.UTC(day.y, day.m, day.d));
}

function fromUtc(date: Date): Day {
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

function addDays(day: Day, count: number): Day {
  const date = utc(day);
  date.setUTCDate(date.getUTCDate() + count);
  return fromUtc(date);
}

function addMonths(day: Day, count: number): Day {
  const first = new Date(Date.UTC(day.y, day.m + count, 1));
  const last = new Date(Date.UTC(day.y, day.m + count + 1, 0)).getUTCDate();
  return { y: first.getUTCFullYear(), m: first.getUTCMonth(), d: Math.min(day.d, last) };
}

/** Today in Dhaka, as a calendar day. */
export function dhakaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function format(value: string, locale: PickerLocale, withYear = true): string {
  const day = parseDay(value);
  if (day === null) return '';
  return new Intl.DateTimeFormat(INTL[locale], {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    ...(withYear ? { year: 'numeric' as const } : {}),
  }).format(utc(day));
}

// --- the calendar --------------------------------------------------------------------

function Calendar({
  value,
  rangeEnd,
  onPick,
  min,
  max,
  locale,
  labels,
  years,
}: {
  /** The picked day, or a range's start. */
  readonly value: string;
  /** A range's end, to shade the days between. */
  readonly rangeEnd?: string;
  readonly onPick: (value: string) => void;
  readonly min?: string;
  readonly max?: string;
  readonly locale: PickerLocale;
  readonly labels: DatePickerLabels;
  /**
   * Offer the month and the year as lists in the header, so a date decades away (a
   * birthday) is three choices rather than hundreds of clicks on a month arrow.
   */
  readonly years?: YearSpan;
}) {
  const today = dhakaToday();
  const initial = parseDay(value) ?? parseDay(today) ?? { y: 2026, m: 0, d: 1 };
  const [focus, setFocus] = useState<Day>(initial);
  const grid = useRef<HTMLDivElement>(null);

  const title = new Intl.DateTimeFormat(INTL[locale], {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(focus.y, focus.m, 1)));

  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(INTL[locale], { timeZone: 'UTC', weekday: 'short' });
    // 2026-01-04 is a Sunday: the week starts on Sunday, as Bangladesh's calendars print it.
    return Array.from({ length: 7 }, (_, index) =>
      format.format(new Date(Date.UTC(2026, 0, 4 + index))),
    );
  }, [locale]);

  const first = new Date(Date.UTC(focus.y, focus.m, 1));
  const start = addDays(fromUtc(first), -first.getUTCDay());
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  const dayFormat = new Intl.DateTimeFormat(INTL[locale], { timeZone: 'UTC', day: 'numeric' });
  const fullFormat = new Intl.DateTimeFormat(INTL[locale], {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const outOfBounds = (iso: string) =>
    (min !== undefined && min !== '' && iso < min) ||
    (max !== undefined && max !== '' && iso > max);

  function move(next: Day) {
    setFocus(next);
    // Focus follows after the render that brings the day into the grid.
    requestAnimationFrame(() => {
      grid.current?.querySelector<HTMLButtonElement>(`[data-day="${toIso(next)}"]`)?.focus();
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const map: Record<string, () => Day> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -utc(focus).getUTCDay()),
      End: () => addDays(focus, 6 - utc(focus).getUTCDay()),
    };
    const step = map[event.key];
    if (step === undefined) return;
    event.preventDefault();
    move(step());
  }

  const focusIso = toIso(focus);
  const low = rangeEnd !== undefined && rangeEnd !== '' && value !== '' ? value : null;
  const high = low === null ? null : (rangeEnd ?? null);

  return (
    <div className="w-[17.5rem] p-3">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label={labels.previousMonth}
          onClick={() => setFocus(addMonths(focus, -1))}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>
        {years === undefined ? (
          <p className="text-sm font-semibold" aria-live="polite">
            {title}
          </p>
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
            <Select
              size="sm"
              className="w-auto min-w-0 flex-1"
              {...(labels.month === undefined ? {} : { 'aria-label': labels.month })}
              value={String(focus.m)}
              onValueChange={(next) => setFocus({ ...focus, m: Number(next), d: 1 })}
              options={Array.from({ length: 12 }, (_, month) => ({
                value: String(month),
                label: new Intl.DateTimeFormat(INTL[locale], {
                  timeZone: 'UTC',
                  month: 'short',
                }).format(new Date(Date.UTC(2026, month, 1))),
              }))}
            />
            <Select
              size="sm"
              className="w-auto min-w-0 flex-1"
              {...(labels.year === undefined ? {} : { 'aria-label': labels.year })}
              value={String(focus.y)}
              onValueChange={(next) => setFocus({ ...focus, y: Number(next), d: 1 })}
              options={Array.from({ length: years.to - years.from + 1 }, (_, index) => {
                const year = years.to - index;
                return {
                  value: String(year),
                  label: new Intl.DateTimeFormat(INTL[locale], {
                    timeZone: 'UTC',
                    year: 'numeric',
                  }).format(new Date(Date.UTC(year, 0, 1))),
                };
              })}
            />
          </div>
        )}
        <button
          type="button"
          aria-label={labels.nextMonth}
          onClick={() => setFocus(addMonths(focus, 1))}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div ref={grid} role="grid" aria-label={title} onKeyDown={onKeyDown}>
        <div role="row" className="grid grid-cols-7">
          {weekdays.map((name) => (
            <span
              key={name}
              role="columnheader"
              className="flex h-8 items-center justify-center text-xs text-muted-foreground"
            >
              {name}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} role="row" className="grid grid-cols-7">
            {days.slice(row * 7, row * 7 + 7).map((day) => {
              const iso = toIso(day);
              const inMonth = day.m === focus.m;
              const picked = iso === value || (high !== null && iso === high);
              const between = low !== null && high !== null && iso > low && iso < high;
              const disabled = outOfBounds(iso);
              return (
                <span key={iso} role="gridcell" aria-selected={picked}>
                  <button
                    type="button"
                    data-day={iso}
                    tabIndex={iso === focusIso ? 0 : -1}
                    disabled={disabled}
                    aria-label={fullFormat.format(utc(day))}
                    aria-current={iso === today ? 'date' : undefined}
                    onClick={() => onPick(iso)}
                    className={cn(
                      'flex size-9 w-full items-center justify-center rounded-md text-sm tabular-nums',
                      'motion-safe:duration-fast motion-safe:transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      'disabled:pointer-events-none disabled:opacity-30',
                      inMonth ? 'text-foreground' : 'text-muted-foreground',
                      between && 'rounded-none bg-primary-subtle',
                      picked
                        ? 'bg-primary font-medium text-primary-foreground hover:bg-primary-hover'
                        : 'hover:bg-accent',
                      iso === today && !picked && 'font-semibold text-primary',
                    )}
                  >
                    {dayFormat.format(utc(day))}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- one date ------------------------------------------------------------------------

export interface DatePickerProps {
  /** `YYYY-MM-DD`, or `''` for none. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly locale: PickerLocale;
  readonly labels: DatePickerLabels;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: boolean | undefined;
  readonly placeholder?: string;
  readonly min?: string;
  readonly max?: string;
  readonly disabled?: boolean;
  /** Offer Clear when the field may be empty. */
  readonly clearable?: boolean;
  /** Month and year lists in the header, for dates far from today (a birthday). */
  readonly years?: YearSpan;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

export function DatePicker({
  value,
  onValueChange,
  locale,
  labels,
  id,
  placeholder,
  min,
  max,
  disabled = false,
  clearable = false,
  years,
  size = 'md',
  className,
  ...aria
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const shown = format(value, locale);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        {...(id === undefined ? {} : { id })}
        {...aria}
        disabled={disabled}
        className={cn(
          controlClassName,
          'inline-flex w-full items-center justify-between gap-2 text-left tabular-nums',
          size === 'sm' && 'h-control-sm px-2.5',
          shown === '' && 'text-muted-foreground',
          className,
        )}
      >
        <span className="truncate">{shown === '' ? (placeholder ?? '') : shown}</span>
        <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-popover outline-none motion-safe:animate-in"
        >
          <Calendar
            value={value}
            locale={locale}
            labels={labels}
            {...(min === undefined ? {} : { min })}
            {...(max === undefined ? {} : { max })}
            {...(years === undefined ? {} : { years })}
            onPick={(next) => {
              onValueChange(next);
              setOpen(false);
            }}
          />
          <Footer>
            <FooterButton
              onClick={() => {
                onValueChange(dhakaToday());
                setOpen(false);
              }}
            >
              {labels.today}
            </FooterButton>
            {clearable && value !== '' ? (
              <FooterButton
                onClick={() => {
                  onValueChange('');
                  setOpen(false);
                }}
              >
                {labels.clear}
              </FooterButton>
            ) : null}
          </Footer>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function Footer({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
      {children}
    </div>
  );
}

function FooterButton({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

// --- a period ------------------------------------------------------------------------

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface RangePreset {
  readonly label: string;
  readonly range: DateRange;
}

export interface DateRangePickerProps {
  readonly value: DateRange;
  readonly onValueChange: (value: DateRange) => void;
  readonly locale: PickerLocale;
  readonly labels: DatePickerLabels;
  /** One click for the periods people ask for most: this month, the last seven days. */
  readonly presets?: readonly RangePreset[];
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly placeholder?: string;
  readonly min?: string;
  readonly max?: string;
  readonly disabled?: boolean;
  readonly clearable?: boolean;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/**
 * A period as one control: the first click picks the start, the second the end (in
 * either order), and a preset picks both. Either end may be open (`''`) when the caller
 * allows it, as a list filter does.
 */
export function DateRangePicker({
  value,
  onValueChange,
  locale,
  labels,
  presets = [],
  id,
  placeholder,
  min,
  max,
  disabled = false,
  clearable = false,
  size = 'md',
  className,
  ...aria
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);

  const sameYear = value.from.slice(0, 4) === value.to.slice(0, 4);
  const shown =
    value.from === '' && value.to === ''
      ? ''
      : value.from === value.to
        ? format(value.from, locale)
        : `${value.from === '' ? '…' : format(value.from, locale, !sameYear)} – ${value.to === '' ? '…' : format(value.to, locale)}`;

  function pick(day: string) {
    if (anchor === null) {
      setAnchor(day);
      onValueChange({ from: day, to: day });
      return;
    }
    const [from, to] = anchor <= day ? [anchor, day] : [day, anchor];
    setAnchor(null);
    onValueChange({ from, to });
    setOpen(false);
  }

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setAnchor(null);
      }}
    >
      <PopoverPrimitive.Trigger
        type="button"
        {...(id === undefined ? {} : { id })}
        {...aria}
        disabled={disabled}
        className={cn(
          controlClassName,
          'inline-flex w-auto min-w-52 items-center justify-between gap-2 text-left tabular-nums',
          size === 'sm' && 'h-control-sm px-2.5',
          shown === '' && 'text-muted-foreground',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{shown === '' ? (placeholder ?? '') : shown}</span>
        </span>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex rounded-lg border border-border bg-popover text-popover-foreground shadow-popover outline-none motion-safe:animate-in"
        >
          {presets.length === 0 ? null : (
            <ul className="w-40 space-y-0.5 border-r border-border p-2">
              {presets.map((preset) => {
                const active = preset.range.from === value.from && preset.range.to === value.to;
                return (
                  <li key={preset.label}>
                    <button
                      type="button"
                      onClick={() => {
                        setAnchor(null);
                        onValueChange(preset.range);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex h-8 w-full items-center rounded-md px-2.5 text-left text-sm',
                        'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        active
                          ? 'bg-selected font-medium text-selected-foreground'
                          : 'text-foreground',
                      )}
                    >
                      {preset.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div>
            <Calendar
              value={anchor ?? value.from}
              rangeEnd={anchor === null ? value.to : ''}
              locale={locale}
              labels={labels}
              {...(min === undefined ? {} : { min })}
              {...(max === undefined ? {} : { max })}
              onPick={pick}
            />
            {clearable && (value.from !== '' || value.to !== '') ? (
              <Footer>
                <span />
                <FooterButton
                  onClick={() => {
                    setAnchor(null);
                    onValueChange({ from: '', to: '' });
                    setOpen(false);
                  }}
                >
                  {labels.clear}
                </FooterButton>
              </Footer>
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// --- a month -------------------------------------------------------------------------

export interface MonthPickerProps {
  /** `YYYY-MM`, or `''` for none. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly locale: PickerLocale;
  /** The arrows move a year here. */
  readonly labels: { readonly previousYear: string; readonly nextYear: string };
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-describedby'?: string | undefined;
  readonly placeholder?: string;
  readonly min?: string;
  readonly max?: string;
  readonly disabled?: boolean;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/** A month (payroll, targets, the leaderboard): a year and twelve month buttons. */
export function MonthPicker({
  value,
  onValueChange,
  locale,
  labels,
  id,
  placeholder,
  min,
  max,
  disabled = false,
  size = 'md',
  className,
  ...aria
}: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const current = /^(\d{4})-(\d{2})$/.exec(value);
  const [year, setYear] = useState(
    current === null ? Number(dhakaToday().slice(0, 4)) : Number(current[1]),
  );
  const monthName = (month: number, style: 'short' | 'long') =>
    new Intl.DateTimeFormat(INTL[locale], { timeZone: 'UTC', month: style }).format(
      new Date(Date.UTC(2026, month, 1)),
    );
  const yearName = (y: number) =>
    new Intl.DateTimeFormat(INTL[locale], { timeZone: 'UTC', year: 'numeric' }).format(
      new Date(Date.UTC(y, 0, 1)),
    );
  const shown =
    current === null
      ? ''
      : `${monthName(Number(current[2]) - 1, 'long')} ${yearName(Number(current[1]))}`;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && current !== null) setYear(Number(current[1]));
      }}
    >
      <PopoverPrimitive.Trigger
        type="button"
        {...(id === undefined ? {} : { id })}
        {...aria}
        disabled={disabled}
        className={cn(
          controlClassName,
          'inline-flex w-full items-center justify-between gap-2 text-left tabular-nums',
          size === 'sm' && 'h-control-sm px-2.5',
          shown === '' && 'text-muted-foreground',
          className,
        )}
      >
        <span className="truncate">{shown === '' ? (placeholder ?? '') : shown}</span>
        <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-popover outline-none motion-safe:animate-in"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label={labels.previousYear}
              onClick={() => setYear(year - 1)}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </button>
            <p className="text-sm font-semibold tabular-nums">{yearName(year)}</p>
            <button
              type="button"
              aria-label={labels.nextYear}
              onClick={() => setYear(year + 1)}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 12 }, (_, month) => {
              const iso = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`;
              const picked = iso === value;
              const outside =
                (min !== undefined && min !== '' && iso < min) ||
                (max !== undefined && max !== '' && iso > max);
              return (
                <button
                  key={iso}
                  type="button"
                  disabled={outside}
                  aria-pressed={picked}
                  aria-label={`${monthName(month, 'long')} ${yearName(year)}`}
                  onClick={() => {
                    onValueChange(iso);
                    setOpen(false);
                  }}
                  className={cn(
                    'h-9 rounded-md text-sm',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    'disabled:pointer-events-none disabled:opacity-30',
                    picked
                      ? 'bg-primary font-medium text-primary-foreground hover:bg-primary-hover'
                      : 'text-foreground hover:bg-accent',
                  )}
                >
                  {monthName(month, 'short')}
                </button>
              );
            })}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
