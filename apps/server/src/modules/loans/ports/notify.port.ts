import type { Tx } from '@elysium/db';

/**
 * What the loans module needs from `modules/notify` (invariant 12): to queue one SMS,
 * inside the reminder's own transaction.
 *
 * Declared here, in the consumer, like the orders module's port, and bound to `NOTIFY_API`
 * in `loans.module.ts`. Queueing writes a message row and a `notify.send` job in the
 * caller's transaction; the gateway is called by that job after commit, never inside it
 * (invariant 6). A reminder that rolls back takes its message with it.
 */
export interface LoansNotifyPort {
  queue(
    tx: Tx,
    orgId: string,
    input: {
      readonly templateKey: string;
      readonly phone: string;
      readonly values: Readonly<Record<string, string>>;
      readonly refType?: string | null;
      readonly refId?: string | null;
      readonly category?: 'otp' | 'transactional' | 'marketing';
      readonly now?: Date;
    },
  ): Promise<{ readonly messageId: string; readonly state: 'queued' | 'suppressed' }>;
}

export const LOANS_NOTIFY_PORT = Symbol('LoansNotifyPort');
