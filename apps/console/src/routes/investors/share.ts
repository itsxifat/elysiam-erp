/**
 * The investor screens' pure helpers: a profit share, and the calendar.
 *
 * Their own module rather than living beside the components, so a unit test can
 * import them without pulling in `../../api.js` — which reads the app's environment
 * at import time and throws in a test process that has none. Same reason
 * `../catalog/slug.ts` exists.
 */

/**
 * `1250` → `12.50%`, and `12.5` → `1250`, both by integer arithmetic.
 *
 * No float in either direction. `0.07 * 100` is `7.000000000000001`, and a share
 * that is a hundredth of a percent out is a share that pays the wrong amount for as
 * long as nobody re-reads it. The `elysium/no-float-money` lint rule bans `toFixed`
 * for the same reason, and it is right to: basis points are not money, but they
 * decide how money divides.
 */
export function percentOfBps(bps: number): string {
  return `${String(Math.trunc(bps / 100))}.${String(bps % 100).padStart(2, '0')}%`;
}

export function bpsFromPercent(value: string): number {
  const [whole = '0', fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

/**
 * Today, as an Asia/Dhaka calendar date (invariant 8).
 *
 * `Intl` with an explicit time zone rather than `new Date().toISOString()`: the
 * browser's own zone is whatever the laptop is set to, and a staff member on a
 * flight would otherwise see yesterday's position as today's.
 */
export function dhakaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The month before this one, as `YYYY-MM`: the latest month that has ended.
 *
 * What the declare dialog opens on. The server refuses a distribution for a month
 * whose profit is not known yet, so a form pre-filled with *this* month would always
 * fail — and a default that always fails is worse than an empty field.
 */
export function lastFinishedMonth(): string {
  const today = dhakaToday();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1
    ? `${String(year - 1)}-12`
    : `${String(year)}-${String(month - 1).padStart(2, '0')}`;
}
