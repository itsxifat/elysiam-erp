import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import {
  isReturnReasonCode,
  summarizeReturnReasons,
  type ReturnReasonCount,
} from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import * as advancesRepo from './advances.repository.js';
import { mapOrderErrors } from './orders.errors.js';
import { orderScopeSql } from './orders.scope.js';

/**
 * Returns by reason (M17 check 3, D-234).
 *
 * The SQL counts recorded reasons per reason and kind over Asia/Dhaka business dates, in the
 * caller's order scope, so a sales agent sees the returns of orders they may read and a
 * branch manager their branch's. The domain turns the counts into the report, with shares
 * that sum to exactly 100%.
 */
@Injectable()
export class ReturnReasonsService {
  async report(context: ActiveContext, request: object, from: string, to: string) {
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await advancesRepo.returnReasonCounts(tx, {
          orgId: context.orgId,
          from,
          to,
          scope: orderScopeSql(context, request),
        });
        const counts: ReturnReasonCount[] = rows.flatMap((row) =>
          // The CHECK on `order_returns` already holds both to the list.
          isReturnReasonCode(row.reason_code) && (row.kind === 'return' || row.kind === 'exchange')
            ? [{ reason: row.reason_code, kind: row.kind, count: row.count }]
            : [],
        );
        return { from, to, ...summarizeReturnReasons(counts) };
      }),
    );
  }
}
