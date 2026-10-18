import { Inject, Injectable } from '@nestjs/common';
import { defineAbilityFor } from '@elysium/contracts';
import type { CustomerPinnedNoteAnswer } from '@elysium/contracts/telephony';
import { withOrg } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi } from './orders.api.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';

/**
 * The note pinned on top of a buyer's caller panel (M47, D-860): what to do with them, or who was
 * handling them, with who wrote it and when.
 *
 * The route declares `update Customer`, and the write is that scope with the sales queue
 * (`ORDERS_API.setPinnedNote`): a supervisor within their grant, a sales agent for the buyers they
 * reach. It also asks `read PhoneCall`, the caller panel's own ability: the note is the panel's,
 * so a role that holds `update Customer` but never sees the panel (marketing) is refused as for a
 * buyer outside the scope, with no oracle. No role's grant is widened.
 */
@Injectable()
export class PinnedNoteService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(IAM_API) private readonly iam: IamApi,
  ) {}

  async pin(
    context: ActiveContext,
    request: AuditableRequest,
    customerId: string,
    body: string,
  ): Promise<CustomerPinnedNoteAnswer> {
    return mapOrderErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (!defineAbilityFor(context).can('read', 'PhoneCall')) {
          throw new OrdersError('CUSTOMER_NOT_FOUND', 'No such buyer.');
        }
        const note = await this.orders.setPinnedNote(tx, context, request, customerId, body);
        if (note === null) return { pinnedNote: null };
        const members = await this.iam.activeMembers(tx, context.orgId);
        return {
          pinnedNote: {
            body: note.body,
            byUserId: note.byUserId,
            byName: members.find((member) => member.userId === note.byUserId)?.name ?? null,
            at: note.at.toISOString(),
          },
        };
      }),
    );
  }
}
