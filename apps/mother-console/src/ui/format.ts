import { formatCount, localiseDigits, type Locale } from '@elysium/i18n';

/**
 * Rates and ratios for people to read, from the basis points the API sends (integer
 * arithmetic only, like money: invariant 1's spirit). Null is "nothing to divide by",
 * shown as a dash rather than a zero.
 */

const DASH = '—';

function roundedDivide(value: bigint, by: bigint): bigint {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rounded = (magnitude * 2n + by) / (2n * by);
  return negative ? -rounded : rounded;
}

/** 1040 bps → "10.4%". */
export function percent(bps: string | null, locale: Locale): string {
  if (bps === null) return DASH;
  const tenths = roundedDivide(BigInt(bps), 10n);
  const negative = tenths < 0n;
  const magnitude = negative ? -tenths : tenths;
  const text = `${negative ? '-' : ''}${(magnitude / 10n).toString()}.${(magnitude % 10n).toString()}%`;
  return localiseDigits(text, locale);
}

/** A signed percentage change: 1040 bps → "+10.4%". */
export function signedPercent(bps: bigint | null, locale: Locale): string {
  if (bps === null) return DASH;
  const text = percent(bps.toString(), locale);
  return bps > 0n ? `+${text}` : text;
}

/** ROAS: 25000 bps → "2.50×". */
export function times(bps: string | null, locale: Locale): string {
  if (bps === null) return DASH;
  const hundredths = roundedDivide(BigInt(bps), 100n);
  const negative = hundredths < 0n;
  const magnitude = negative ? -hundredths : hundredths;
  const text = `${negative ? '-' : ''}${(magnitude / 100n).toString()}.${(magnitude % 100n)
    .toString()
    .padStart(2, '0')}×`;
  return localiseDigits(text, locale);
}

export function count(value: number, locale: Locale): string {
  return formatCount(value, locale);
}

/** The change from `before` to `now` in basis points, or null without a base. */
export function changeBps(now: bigint, before: bigint): bigint | null {
  if (before === 0n) return null;
  return roundedDivide((now - before) * 10_000n, before < 0n ? -before : before);
}

export interface AgeWords {
  readonly justNow: string;
  readonly minutes: string;
  readonly hours: string;
  readonly days: string;
}

/** How old a figure is: "just now", "12 min ago", "3 h ago", "2 d ago". */
export function age(iso: string, now: Date, words: AgeWords, locale: Locale): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return words.justNow;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${count(minutes, locale)} ${words.minutes}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${count(hours, locale)} ${words.hours}`;
  return `${count(Math.floor(hours / 24), locale)} ${words.days}`;
}
