import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { normalizeBdPhone } from '@elysium/domain';

import * as repo from './notify.repository.js';
import { NotifyService } from './notify.service.js';

/**
 * What another module may ask of notifications (M16; invariant 12).
 *
 * One method: queue a message from a template, inside the caller's transaction. The
 * occasions job is the first caller — a birthday code and the text announcing it commit
 * together or not at all, so a buyer is never told about a code that rolled back.
 *
 * Quiet hours, opt-outs and the delivery log are this module's business and stay here: a
 * caller says what to send and to whom, and learns whether it was queued or suppressed.
 */
export interface NotifyApi {
  queue(
    tx: Tx,
    orgId: string,
    input: {
      readonly templateKey: string;
      /** Any form `normalizeBdPhone` accepts; stored national. */
      readonly phone: string;
      readonly locale: 'bn' | 'en';
      readonly values: Readonly<Record<string, string>>;
      /** What caused it, ids only: `occasion`, `order`. */
      readonly refType?: string | null;
      readonly refId?: string | null;
      readonly now?: Date;
    },
  ): Promise<{ readonly messageId: string; readonly state: 'queued' | 'suppressed' }>;

  /**
   * Every number in the brand that opted out of marketing SMS, in E.164.
   *
   * For a list built to be texted or advertised to — the re-engagement export — which has
   * to leave these buyers out before the file exists, because once it is downloaded this
   * module's suppression can no longer reach it. E.164 because that is how every other
   * module stores a buyer's phone; the opt-out table keeps the national form.
   */
  optedOutPhones(tx: Tx, orgId: string): Promise<readonly string[]>;
}

export const NOTIFY_API = Symbol('NotifyApi');

@Injectable()
export class NotifyApiService implements NotifyApi {
  constructor(@Inject(NotifyService) private readonly notify: NotifyService) {}

  async queue(
    tx: Tx,
    orgId: string,
    input: Parameters<NotifyApi['queue']>[2],
  ): Promise<{ readonly messageId: string; readonly state: 'queued' | 'suppressed' }> {
    const { messageId, state } = await this.notify.queue(tx, orgId, input);
    return { messageId, state };
  }

  async optedOutPhones(tx: Tx, orgId: string): Promise<readonly string[]> {
    const national = await repo.optedOutPhones(tx, orgId, 'sms');
    return national.map((phone) => normalizeBdPhone(phone));
  }
}
