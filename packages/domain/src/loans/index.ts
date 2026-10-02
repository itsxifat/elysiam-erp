/**
 * Company loans (architecture §15, M26): the schedule and the reminder window.
 *
 * Pure functions only. The posting rules that turn a receipt and a repayment into
 * journals live in `../posting/company-loan.ts`; the tables, approvals and the reminder
 * job live in the server's `loans` module.
 */
export * from './reminders.js';
export * from './schedule.js';
