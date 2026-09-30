import { addDays, businessDate } from '../dates/index.js';

/**
 * Quiet hours (architecture §10, M16 check 4): nothing but a one-time code is sent
 * between 21:00 and 09:00 Asia/Dhaka.
 *
 * A message due inside the window waits for the next 09:00. Bangladesh has kept
 * UTC+6 all year since 2009, so 09:00 in Dhaka is 03:00 UTC on the same calendar
 * date; the calendar date itself still comes from `businessDate`, never from the
 * machine's own zone.
 *
 * The send job asks again when it runs, not only when it was scheduled: a job held
 * up until after 21:00 by an outage defers instead of waking someone at midnight.
 */

export const QUIET_FROM_HOUR = 21;
export const QUIET_UNTIL_HOUR = 9;

export type MessageCategory = 'otp' | 'transactional' | 'marketing';

function dhakaHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at),
  );
}

export function inQuietHours(at: Date): boolean {
  const hour = dhakaHour(at);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/** When a message of this kind may go out, given that it is due `now`. */
export function nextSendTime(now: Date, category: MessageCategory): Date {
  if (category === 'otp' || !inQuietHours(now)) return now;
  const today = businessDate(now);
  const day = dhakaHour(now) >= QUIET_FROM_HOUR ? addDays(today, 1) : today;
  return new Date(`${day}T03:00:00.000Z`);
}
