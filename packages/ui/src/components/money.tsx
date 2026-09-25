import { formatMoney, type Locale } from '@elysium/i18n';

import { cn } from '../lib/cn.js';

/**
 * Money on screen (architecture §24, invariant 1).
 *
 * The only way this system renders an amount. Three things are wired in here so
 * that no call site has to remember them:
 *
 * 1. **Integer poisha in, never a float.** The prop is a `bigint` or a decimal
 *    string, because a poisha amount at crore scale is above `Number.MAX_SAFE_INTEGER`
 *    and passing it as a JavaScript number rounds it silently. That is the exact
 *    failure invariant 1 exists to prevent, and a component taking `number`
 *    would reintroduce it at every screen.
 * 2. **Tabular numerals.** §24 requires them, and the reason is that a column of
 *    proportional digits does not line up — an accountant scanning a cash book
 *    for an anomaly is reading the *shape* of the column, and proportional
 *    figures destroy that signal.
 * 3. **`formatMoney`**, so grouping is lakh/crore rather than thousands. ৳১,২৩,৪৫৬.৭৮,
 *    not ৳123,456.78. Getting this wrong is not a cosmetic bug in Bangladesh; it
 *    is a number the reader has to stop and re-parse.
 *
 * Right-aligned by default, because that is what makes a column readable and
 * because remembering to pass an alignment at every call site is how half a
 * table ends up left-aligned.
 */
export interface MoneyProps {
  /** Integer poisha. A bigint, or a decimal string as it crossed the wire. */
  readonly poisha: bigint | string;
  readonly locale?: Locale;
  /** Drop the ৳ where the column header already names the currency. */
  readonly symbol?: boolean;
  /**
   * Withheld rather than absent.
   *
   * §6 and invariant 5: a role without `read:cost` receives no cost field at
   * all, so the value genuinely is not here. Rendering an em dash and a title
   * says "you may not see this" instead of implying the amount is zero — which
   * is what a bare `—` or a `0` would do, and a zero in a money column is a
   * fact, not an absence.
   */
  readonly withheld?: boolean;
  readonly className?: string;
  /** Left-align, for the rare case where the amount is prose rather than a column. */
  readonly align?: 'start' | 'end';
}

export function Money({
  poisha,
  locale = 'en',
  symbol = true,
  withheld = false,
  className,
  align = 'end',
}: MoneyProps) {
  if (withheld) {
    return (
      <span
        className={cn('text-muted-foreground tabular-nums', alignClass(align), className)}
        title="You do not have permission to see this amount."
        aria-label="amount withheld"
      >
        &mdash;
      </span>
    );
  }

  return (
    <span className={cn('tabular-nums', alignClass(align), className)}>
      {formatMoney(poisha, { locale, symbol })}
    </span>
  );
}

function alignClass(align: 'start' | 'end'): string {
  return align === 'end' ? 'text-right' : 'text-left';
}
