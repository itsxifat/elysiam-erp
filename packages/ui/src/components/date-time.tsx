import { cn } from '../lib/cn.js';

/**
 * A timestamp, always in Asia/Dhaka (invariant 8, §24).
 *
 * The rule is that business dates are Dhaka calendar dates and timestamps are
 * stored as `timestamptz`. On screen that means one thing: the zone is **not**
 * the viewer's. An accountant in Dhaka and a super admin travelling must read
 * the same closing date off the same row, and `toLocaleString()` with no zone
 * gives them different ones — quietly, and only sometimes, which is worse than
 * always.
 *
 * The concrete failure it prevents: an order placed at 23:30 Dhaka on the 1st
 * belongs to the 1st. Rendered in the browser's zone from a machine set to UTC,
 * it reads as 17:30 on the 1st — the same day by luck. At 05:30 Dhaka on the 2nd
 * it reads as the 1st, and now the day book and the screen disagree about which
 * day's takings a row belongs to. Nobody notices until a variance.
 *
 * `dateOnly` exists because a business date is not a moment. A period, a closing
 * and a payroll run are *days*, and rendering them with a time invites the
 * reader to wonder which timezone the 00:00 is in.
 */
const DHAKA = 'Asia/Dhaka';

export interface DateTimeProps {
  /** An instant: a `Date`, or the ISO string it arrived as. */
  readonly value: Date | string;
  /** Render the Dhaka calendar date alone, for business dates. */
  readonly dateOnly?: boolean;
  /** Without the year, for a table column of recent rows: "03 Oct, 12:14" (D-456). */
  readonly compact?: boolean;
  readonly className?: string;
}

export function DateTime({ value, dateOnly = false, compact = false, className }: DateTimeProps) {
  const instant = typeof value === 'string' ? new Date(value) : value;

  if (Number.isNaN(instant.getTime())) {
    // A bad timestamp renders as an em dash rather than "Invalid Date", which is
    // a string no user should ever be shown and which tells them nothing.
    return (
      <span className={cn('text-muted-foreground', className)} aria-label="unknown date">
        &mdash;
      </span>
    );
  }

  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: DHAKA,
    ...(compact ? {} : { year: 'numeric' as const }),
    month: 'short',
    day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
  }).format(instant);

  return (
    // `dateTime` carries the full instant so a machine reading the page — a
    // screen reader, a scraper, a test — gets the unambiguous value while the
    // human sees Dhaka time.
    <time dateTime={instant.toISOString()} className={cn('tabular-nums', className)}>
      {formatted}
    </time>
  );
}
