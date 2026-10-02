/**
 * How the analytics screens show rates and durations (M24). The server sends basis points
 * as decimal strings, already rounded once by the domain's rule; these only place the
 * decimal point. Money goes through `<Money>`, never through here.
 */

export { daysInclusive, dhakaToday, monthStart, percent, roas } from '../marketing/format.js';

/** A signed rate for growth: 5,000 bps → "+50.0%", -1,250 → "−12.5%". Null → "—". */
export function signedPercent(bps: string | null): string {
  if (bps === null) return '—';
  const value = BigInt(bps);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const tenths = (magnitude + 5n) / 10n;
  const text = `${(tenths / 10n).toString()}.${(tenths % 10n).toString()}%`;
  if (tenths === 0n) return text;
  return `${negative ? '−' : '+'}${text}`;
}

/** Seconds as "45 s" or "12 min 5 s", from the section's two templates. */
export function duration(
  seconds: number | null,
  templates: { readonly seconds: string; readonly minutes: string },
): string {
  if (seconds === null) return '—';
  if (seconds < 60) return templates.seconds.replace('{n}', String(seconds));
  return templates.minutes
    .replace('{m}', String(Math.floor(seconds / 60)))
    .replace('{s}', String(seconds % 60));
}
