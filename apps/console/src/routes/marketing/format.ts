/**
 * How the marketing screens show §11's ratios (M18).
 *
 * The server sends basis points as decimal strings, already rounded once by the domain's
 * rule; these only place the decimal point. No float ever holds a money amount here.
 */

/** ROAS: 6,625 bps → "0.66×", 17,778 → "1.78×". Null (no spend) → "—". */
export function roas(bps: string | null): string {
  if (bps === null) return '—';
  // Two decimals, rounded half up on the dropped digits, as `percent` rounds (bps are never
  // negative here).
  const hundredths = (BigInt(bps) + 50n) / 100n;
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}×`;
}

/** A rate: 2,500 bps → "25.0%", 1,429 → "14.3%". Null (nothing to divide by) → "—". */
export function percent(bps: string | null): string {
  if (bps === null) return '—';
  const value = BigInt(bps);
  // One decimal, rounded half up on the dropped digit (bps are never negative here).
  const tenths = (value + 5n) / 10n;
  return `${(tenths / 10n).toString()}.${(tenths % 10n).toString()}%`;
}

/** Today in Asia/Dhaka as YYYY-MM-DD (invariant 8), whatever the browser's zone. */
export function dhakaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The first of the month of a YYYY-MM-DD date. */
export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Days from `from` to `to`, both inclusive. */
export function daysInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}
