import { Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { MovementsService } from './movements.service.js';
import * as repo from './inventory.repository.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import type { DispatchTransferInput } from './inventory.schemas.js';

/**
 * Two-step transfers (architecture §8 "Transfers").
 *
 * Step one takes the stock off the source shelf and puts it in the org's
 * `in_transit` location. Step two takes it out of in-transit and onto the
 * destination shelf. Four movements per transfer, not two, and that is what makes
 * the second step meaningful: between dispatch and receipt the units exist, at a
 * place, on the same screens as everything else, and the nightly reconciliation
 * counts them.
 *
 * The alternative — decrement the source now, increment the destination later — was
 * considered and is worse in the way that matters. Stock in a van would belong to no
 * location, so `Σ movements` would not equal `Σ levels` for the duration, the
 * reconciliation would report drift every night a transfer was open, and the
 * difference between "in transit" and "lost" would be a date field rather than a
 * quantity somewhere.
 *
 * A shortfall on receipt is deliberately **not** handled here. The units are
 * received as dispatched, and anything missing is written off from the in-transit
 * location — which needs an approval (D-143). That is the right control: stock that
 * left a warehouse and did not arrive is exactly the event a second person should
 * sign off on, and letting the receiving clerk type a smaller number would make it
 * a typo instead.
 */

export interface TransferView {
  readonly id: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly transitLocationId: string;
  readonly status: string;
  readonly memo: string | null;
  readonly createdBy: string;
  readonly receivedBy: string | null;
  readonly lines: readonly { skuId: string; qty: number }[];
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly movements: MovementsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The brand's in-transit location, created on the first transfer when it has none
   * (D-428). §8 passes every transfer through one, and an owner should never have to
   * know that before moving stock to a showroom. Created in the dispatch's transaction,
   * so a refused transfer leaves no location behind, and audited like a location made
   * on the setup screen.
   */
  private async inTransit(tx: Tx, context: ActiveContext, request: AuditableRequest) {
    const existing = await repo.inTransitLocation(tx, context.orgId);
    if (existing !== undefined) return existing;

    // One in-transit location per brand (§8): a switched-off one is pointed at, not
    // replaced by a second (ledger audit L2).
    const off = await repo.anyInTransitLocation(tx, context.orgId);
    if (off !== undefined) {
      throw new StockError(
        'STOCK_LOCATION_INVALID',
        `The in-transit location ${off.code} is switched off. Switch it back on in Catalog setup to send stock.`,
      );
    }

    /*
     * `on conflict do nothing` under READ COMMITTED (withOrg sets no other level): the
     * second of two first transfers waits for the first's insert, finds the row taken,
     * and its re-read below sees the committed location. Under REPEATABLE READ it would
     * fail with a serialization error instead, so this depends on the default level.
     */
    const created = await repo.insertInTransitLocation(tx, context.orgId);
    if (created !== undefined) {
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'inventory.location.created',
        entityType: 'Location',
        entityId: created,
        before: null,
        after: {
          code: repo.AUTO_IN_TRANSIT_CODE,
          name: 'In transit',
          kind: 'in_transit',
          branchId: null,
          reason: 'first transfer',
        },
        requestId: context.requestId,
        request,
      });
    }
    return repo.inTransitLocation(tx, context.orgId);
  }

  /** Step one: out of the source, into in-transit. */
  async dispatch(
    context: ActiveContext,
    request: AuditableRequest,
    input: DispatchTransferInput,
  ): Promise<TransferView> {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const from = await repo.locationById(tx, context.orgId, input.fromLocationId);
        const to = await repo.locationById(tx, context.orgId, input.toLocationId);
        if (from === undefined || to === undefined) {
          throw new StockError('STOCK_LOCATION_INVALID', 'No such location in this brand.');
        }
        if (!from.is_active || !to.is_active) {
          throw new StockError('STOCK_LOCATION_INVALID', 'A transfer needs two active locations.');
        }
        if (from.kind === 'in_transit' || to.kind === 'in_transit') {
          throw new StockError(
            'STOCK_TRANSFER_INVALID',
            'In-transit is where a transfer passes through, not an end of one.',
          );
        }
        // The stock is leaving this branch, so a branch manager must own it. The
        // destination is deliberately not scope-checked: sending stock to another
        // branch is the ordinary case, and refusing it would make a showroom unable
        // to return stock to the warehouse.
        assertInScope(request, { branchId: from.branch_id });

        const transit = await this.inTransit(tx, context, request);
        if (transit === undefined) {
          // The code is taken by a location of another kind, so none could be made.
          throw new StockError(
            'STOCK_LOCATION_INVALID',
            `A location already uses the code ${repo.AUTO_IN_TRANSIT_CODE}, so the in-transit location could not be created (§8).`,
          );
        }

        const transferId = await repo.insertTransfer(tx, {
          orgId: context.orgId,
          fromLocationId: from.id,
          toLocationId: to.id,
          transitLocationId: transit.id,
          memo: input.memo ?? null,
          createdBy: context.userId,
        });

        const occurredAt = new Date();
        for (const line of input.lines) {
          await repo.insertTransferLine(tx, {
            orgId: context.orgId,
            transferId,
            skuId: line.skuId,
            qty: line.qty,
          });
          await this.movements.apply(tx, context, {
            skuId: line.skuId,
            locationId: from.id,
            kind: 'transfer_out',
            qty: line.qty,
            refType: 'transfer',
            refId: transferId,
            dedupeKey: `transfer:${transferId}:out:${line.skuId}`,
            occurredAt,
            memo: input.memo ?? null,
          });
          await this.movements.apply(tx, context, {
            skuId: line.skuId,
            locationId: transit.id,
            kind: 'transfer_in',
            qty: line.qty,
            refType: 'transfer',
            refId: transferId,
            dedupeKey: `transfer:${transferId}:transit_in:${line.skuId}`,
            occurredAt,
            memo: input.memo ?? null,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'inventory.transfer.dispatched',
          entityType: 'StockTransfer',
          entityId: transferId,
          before: null,
          after: {
            fromLocationId: from.id,
            toLocationId: to.id,
            lines: input.lines,
          },
          requestId: context.requestId,
          request,
        });

        return this.load(tx, context.orgId, transferId);
      }),
    );
  }

  /** Step two: out of in-transit, onto the destination shelf. */
  async receive(
    context: ActiveContext,
    request: AuditableRequest,
    transferId: string,
  ): Promise<TransferView> {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const transfer = await repo.transferById(tx, context.orgId, transferId);
        if (transfer === undefined) {
          throw new StockError('STOCK_NOT_FOUND', 'No such transfer.');
        }
        const to = await repo.locationById(tx, context.orgId, transfer.to_location_id);
        if (to === undefined) {
          throw new StockError('STOCK_LOCATION_INVALID', 'That transfer names a missing location.');
        }
        // Receiving is the destination branch's act, so the scope check is on the
        // destination — the mirror of dispatch.
        assertInScope(request, { branchId: to.branch_id });

        if (transfer.status === 'received') return this.load(tx, context.orgId, transferId);
        if (transfer.status !== 'dispatched') {
          throw new StockError('STOCK_TRANSFER_INVALID', `That transfer is ${transfer.status}.`);
        }

        // Claim the transfer first. `markTransferReceived` only matches a row still
        // `dispatched`, so two clerks pressing receive at once produce one receipt
        // and one refusal rather than two sets of movements.
        if (!(await repo.markTransferReceived(tx, context.orgId, transferId, context.userId))) {
          throw new StockError(
            'STOCK_TRANSFER_INVALID',
            'That transfer has already been received.',
          );
        }

        const occurredAt = new Date();
        for (const line of await repo.transferLines(tx, context.orgId, transferId)) {
          await this.movements.apply(tx, context, {
            skuId: line.sku_id,
            locationId: transfer.transit_location_id,
            kind: 'transfer_out',
            qty: line.qty,
            refType: 'transfer',
            refId: transferId,
            dedupeKey: `transfer:${transferId}:transit_out:${line.sku_id}`,
            occurredAt,
            memo: null,
          });
          await this.movements.apply(tx, context, {
            skuId: line.sku_id,
            locationId: transfer.to_location_id,
            kind: 'transfer_in',
            qty: line.qty,
            refType: 'transfer',
            refId: transferId,
            dedupeKey: `transfer:${transferId}:in:${line.sku_id}`,
            occurredAt,
            memo: null,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.transfer.received',
          entityType: 'StockTransfer',
          entityId: transferId,
          before: { status: 'dispatched' },
          after: { status: 'received', receivedBy: context.userId },
          requestId: context.requestId,
          request,
        });

        return this.load(tx, context.orgId, transferId);
      }),
    );
  }

  async list(
    context: ActiveContext,
    request: object,
    filters: { readonly status?: string | undefined },
  ): Promise<{ items: TransferView[] }> {
    const scope = scopeWhere(request, { branchId: sql`l.branch_id`, createdBy: sql`t.created_by` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listTransfers(tx, context.orgId, { scope, status: filters.status });
      return {
        items: await Promise.all(rows.map((row) => this.load(tx, context.orgId, row.id))),
      };
    });
  }

  private async load(
    tx: Parameters<typeof repo.transferById>[0],
    orgId: string,
    id: string,
  ): Promise<TransferView> {
    const row = await repo.transferById(tx, orgId, id);
    if (row === undefined) throw new StockError('STOCK_NOT_FOUND', 'No such transfer.');
    const lines = await repo.transferLines(tx, orgId, id);
    return {
      id: row.id,
      fromLocationId: row.from_location_id,
      toLocationId: row.to_location_id,
      transitLocationId: row.transit_location_id,
      status: row.status,
      memo: row.memo,
      createdBy: row.created_by,
      receivedBy: row.received_by,
      lines: lines.map((line) => ({ skuId: line.sku_id, qty: line.qty })),
    };
  }
}
