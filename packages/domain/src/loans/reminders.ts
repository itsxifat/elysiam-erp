import { addDays, type IsoDate } from '../dates/index.js';

/** How many days ahead a reminder goes out by default (D-300, ASSUMED). */
export const DEFAULT_REMINDER_DAYS = 3;
/** The furthest ahead a brand may ask to be reminded. */
export const MAX_REMINDER_DAYS = 30;

/** The Asia/Dhaka date an instalment's reminder is due: `reminderDays` before it. */
export function reminderDate(dueOn: IsoDate, reminderDays: number): IsoDate {
  return addDays(dueOn, -reminderDays);
}

/**
 * Is an unpaid instalment's reminder due on `today`?
 *
 * On or after its reminder date, and not only on it: a job that did not run for two days
 * (an outage, a deploy) still reminds once on the next run, even when the due date has
 * passed — an overdue instalment nobody was told about is the case a reminder exists
 * for. "Once" is the caller's unique row, not this function (M26 check 3).
 */
export function isReminderDue(dueOn: IsoDate, reminderDays: number, today: IsoDate): boolean {
  return today >= reminderDate(dueOn, reminderDays);
}
