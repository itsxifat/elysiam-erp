import type { Tx } from '@elysium/db';

/**
 * What the orders module needs from `modules/notify` (invariant 12): to queue one message,
 * inside its own transaction.
 *
 * Declared here, in the consumer, like `promo.port.ts`, so this module states exactly what
 * it asks for and is bound to `NOTIFY_API` in `orders.module.ts`. The CRM's occasion job is
 * the caller: a greeting and the code it announces commit together, so a buyer is never
 * texted about a code that was rolled back.
 */
export interface NotifyPort {
  queue(
    tx: Tx,
    orgId: string,
    input: {
      readonly templateKey: string;
      readonly phone: string;
      readonly locale: 'bn' | 'en';
      readonly values: Readonly<Record<string, string>>;
      readonly refType?: string | null;
      readonly refId?: string | null;
      readonly now?: Date;
    },
  ): Promise<{ readonly messageId: string; readonly state: 'queued' | 'suppressed' }>;
}

export const NOTIFY_PORT = Symbol('OrdersNotifyPort');
