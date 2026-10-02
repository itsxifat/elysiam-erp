import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha, takaParts } from '@elysium/domain';
import { lapsedSince } from '@elysium/domain/crm';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { EXPORT_ROW_LIMIT } from './buyers.service.js';
import * as crm from './crm.repository.js';
import {
  CSV_CONTENT_TYPE,
  toCsv,
  toXlsx,
  XLSX_CONTENT_TYPE,
  type TabularCell,
  type TabularColumn,
} from './export/tabular.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import type { ReengagementExportQuery, ReengagementQuery } from './orders.schemas.js';
import { NOTIFY_PORT, type NotifyPort } from './ports/notify.port.js';

/**
 * Buyers who have not bought for a while, and the file a campaign is built from
 * (architecture §10 "Re-engagement lists"; M16).
 *
 * Gated, audited and capped exactly as the buyer list is (D-148): it is the same kind of
 * thing, a list of phone numbers, and a second list with a looser gate would be the way
 * round the first. See `buyers.service.ts` for the reasoning; it is not repeated here.
 *
 * **Opted-out numbers never appear** — not on the page, not in the count, not in the file.
 * A buyer who asked for no more offers asked the brand, not one channel of it, and a
 * downloaded file is out of reach of the notify module's suppression the moment it exists
 * (D-208).
 */

export interface LapsedBuyerView {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string;
  readonly segment: string | null;
  readonly delivered: number;
  readonly ltvPoisha: string;
  /** Asia/Dhaka calendar date of the latest order that was not cancelled. */
  readonly lastOrderOn: string;
}

function toView(row: crm.LapsedRow): LapsedBuyerView {
  return {
    customerId: row.customer_id,
    name: row.name,
    phone: row.phone_e164,
    segment: row.segment,
    delivered: row.delivered_count,
    ltvPoisha: row.ltv_poisha,
    lastOrderOn: row.last_order_on,
  };
}

const EXPORT_COLUMNS: readonly TabularColumn[] = [
  { header: 'Name', kind: 'text' },
  { header: 'Phone', kind: 'phone' },
  { header: 'Segment', kind: 'text' },
  { header: 'Delivered orders', kind: 'number' },
  { header: 'Lifetime value (Tk)', kind: 'text' },
  { header: 'Last order (Asia/Dhaka)', kind: 'date' },
];

/** Exact taka with two decimals, as text: a float column would round somebody's money. */
function taka(value: string): string {
  const parts = takaParts(poisha(value));
  return `${parts.negative ? '-' : ''}${String(parts.taka)}.${String(parts.poisha).padStart(2, '0')}`;
}

function exportCells(row: crm.LapsedRow): TabularCell[] {
  return [
    row.name,
    row.phone_e164,
    row.segment,
    row.delivered_count,
    taka(row.ltv_poisha),
    row.last_order_on,
  ];
}

@Injectable()
export class ReengagementService {
  constructor(
    private readonly audit: AuditService,
    @Inject(NOTIFY_PORT) private readonly notify: NotifyPort,
  ) {}

  private scope(request: object) {
    return scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
  }

  private async filters(
    tx: Tx,
    orgId: string,
    query: ReengagementQuery | ReengagementExportQuery,
    now: Date,
  ): Promise<crm.ReengagementFilters> {
    return {
      lastOrderOnOrBefore: lapsedSince(businessDate(now), query.days),
      minDelivered: query.minDelivered,
      segment: query.segment,
      excludePhones: await this.notify.optedOutPhones(tx, orgId),
    };
  }

  async list(context: ActiveContext, request: object, query: ReengagementQuery, now = new Date()) {
    const scope = this.scope(request);
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const filters = await this.filters(tx, context.orgId, query, now);
        const [rows, total] = await Promise.all([
          crm.lapsedRows(tx, context.orgId, filters, scope, {
            limit: query.limit,
            offset: query.offset,
          }),
          crm.lapsedCount(tx, context.orgId, filters, scope),
        ]);
        return { items: rows.map(toView), total, lastOrderOnOrBefore: filters.lastOrderOnOrBefore };
      }),
    );
  }

  /** Every lapsed buyer as a file. Refused above the cap, never truncated (D-148). */
  async export(
    context: ActiveContext,
    request: object,
    query: ReengagementExportQuery,
    now = new Date(),
  ): Promise<{ bytes: Buffer; filename: string; contentType: string; rows: number }> {
    const scope = this.scope(request);
    const rows = await mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const filters = await this.filters(tx, context.orgId, query, now);
        const total = await crm.lapsedCount(tx, context.orgId, filters, scope);
        if (total > EXPORT_ROW_LIMIT) {
          throw new OrdersError(
            'VALIDATION_FAILED',
            `That filter matches ${String(total)} buyers; narrow it below ${String(EXPORT_ROW_LIMIT)} to export.`,
          );
        }
        const found = await crm.lapsedRows(tx, context.orgId, filters, scope, null);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'buyers.reengagement_exported',
          entityType: 'buyer_export',
          entityId: randomUUID(),
          // The filters and the count, never the rows or the opt-out list.
          after: {
            format: query.format,
            rows: found.length,
            filters: {
              days: query.days,
              minDelivered: query.minDelivered,
              segment: query.segment ?? null,
              lastOrderOnOrBefore: filters.lastOrderOnOrBefore,
            },
          },
        });
        return found;
      }),
    );

    // Built after the commit, for the reason `BuyersService.export` gives.
    const cells = rows.map(exportCells);
    const bytes =
      query.format === 'xlsx'
        ? toXlsx('Re-engagement', EXPORT_COLUMNS, cells)
        : toCsv(EXPORT_COLUMNS, cells);
    return {
      bytes,
      filename: `reengagement-${businessDate(now)}.${query.format}`,
      contentType: query.format === 'xlsx' ? XLSX_CONTENT_TYPE : CSV_CONTENT_TYPE,
      rows: rows.length,
    };
  }
}
