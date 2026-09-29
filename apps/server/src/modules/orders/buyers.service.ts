import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { businessDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './buyers.repository.js';
import {
  CSV_CONTENT_TYPE,
  toCsv,
  toXlsx,
  XLSX_CONTENT_TYPE,
  type TabularColumn,
  type TabularCell,
} from './export/tabular.js';
import { mapOrderErrors, OrdersError } from './orders.errors.js';
import type { BuyerExportQuery, BuyerQuery } from './orders.schemas.js';

/**
 * The buyer list and its export (M11 Build list; acceptance check 2).
 *
 * Behind `export BuyerExport`, which §6 gives to org_admin and marketing and to nobody who
 * takes orders. The list is phone numbers of everybody who bought a thing, which is the
 * most reusable personal data this system holds — so the page and the file are one grant,
 * not two: a role that could page through the list could copy it by hand anyway.
 *
 * The export writes an audit row with the filters and the row count and **not** the rows.
 * Who took which list, and when, is what an incident needs; a second copy of every number
 * in an append-only table is what an incident would be about.
 */

/** Ten times the largest brand's buyer base today. A safety valve, not a page size. */
export const EXPORT_ROW_LIMIT = 100_000;

export interface BuyerView {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string;
  readonly district: string | null;
  readonly thana: string | null;
  readonly orders: number;
  readonly units: number;
  readonly lastOrderAt: string;
}

function toView(row: repo.BuyerRow): BuyerView {
  return {
    customerId: row.customer_id,
    name: row.name,
    phone: row.phone_e164,
    district: row.district_en,
    thana: row.thana_en,
    orders: Number(row.orders),
    units: Number(row.units),
    lastOrderAt: new Date(row.last_order_at).toISOString(),
  };
}

const EXPORT_COLUMNS: readonly TabularColumn[] = [
  { header: 'Name', kind: 'text' },
  { header: 'Phone', kind: 'phone' },
  { header: 'District', kind: 'text' },
  { header: 'Thana', kind: 'text' },
  { header: 'Orders', kind: 'number' },
  { header: 'Units', kind: 'number' },
  { header: 'Last order (Asia/Dhaka)', kind: 'date' },
];

function exportCells(row: repo.BuyerRow): TabularCell[] {
  return [
    row.name,
    row.phone_e164,
    row.district_en,
    row.thana_en,
    Number(row.orders),
    Number(row.units),
    // The Dhaka calendar date, not the UTC instant: a list of "bought this week" is read
    // by someone in Dhaka, and an order at 01:00 their time belongs to their today.
    businessDate(new Date(row.last_order_at)),
  ];
}

function filtersOf(query: BuyerQuery | BuyerExportQuery): repo.BuyerFilters {
  return {
    product: query.product,
    sku: query.sku,
    size: query.size,
    from: query.from,
    to: query.to,
    channel: query.channel,
  };
}

@Injectable()
export class BuyersService {
  constructor(private readonly audit: AuditService) {}

  async list(context: ActiveContext, request: object, query: BuyerQuery) {
    const scope = scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
    return mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const filters = filtersOf(query);
        const [rows, total] = await Promise.all([
          repo.buyerRows(tx, context.orgId, filters, scope, {
            limit: query.limit,
            offset: query.offset,
          }),
          repo.buyerCount(tx, context.orgId, filters, scope),
        ]);
        return { items: rows.map(toView), total };
      }),
    );
  }

  /**
   * The same rows as the list, every one of them, as a file.
   *
   * Counted first and refused above the limit rather than truncated: a file that silently
   * stops at a hundred thousand rows is a campaign that silently misses everyone after
   * that, and nobody would find out from the file.
   */
  async export(
    context: ActiveContext,
    request: object,
    query: BuyerExportQuery,
  ): Promise<{ bytes: Buffer; filename: string; contentType: string; rows: number }> {
    const scope = scopeWhere(request, {
      createdBy: sql`o.created_by`,
      assignedTo: sql`o.assigned_to`,
      branchId: sql`o.branch_id`,
    });
    const filters = filtersOf(query);
    const rows = await mapOrderErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const total = await repo.buyerCount(tx, context.orgId, filters, scope);
        if (total > EXPORT_ROW_LIMIT) {
          throw new OrdersError(
            'VALIDATION_FAILED',
            `That filter matches ${String(total)} buyers; narrow it below ${String(EXPORT_ROW_LIMIT)} to export.`,
          );
        }
        const found = await repo.buyerRows(tx, context.orgId, filters, scope, null);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'buyers.exported',
          entityType: 'buyer_export',
          entityId: randomUUID(),
          // The filters and the count. Never the rows: see the class comment.
          after: { format: query.format, rows: found.length, filters: { ...filters } },
        });
        return found;
      }),
    );

    /*
     * The file is built after the commit, not inside the transaction: compressing a
     * hundred thousand rows is CPU work that would otherwise hold a pool connection and a
     * snapshot open for its whole length, on the pool the order desk is using.
     */
    const cells = rows.map(exportCells);
    const bytes =
      query.format === 'xlsx'
        ? toXlsx('Buyers', EXPORT_COLUMNS, cells)
        : toCsv(EXPORT_COLUMNS, cells);
    return {
      bytes,
      filename: `buyers-${businessDate(new Date())}.${query.format}`,
      contentType: query.format === 'xlsx' ? XLSX_CONTENT_TYPE : CSV_CONTENT_TYPE,
      rows: rows.length,
    };
  }
}
