import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './courier.repository.js';
import type { ReceiveReturnInput } from './courier.schemas.js';
import { ReturnsService } from './returns.service.js';

/**
 * What the courier module offers other modules (invariant 12): the parcel an order went out in
 * and the receipt of a returned parcel (M51, D-934). The packing module's return station scans
 * and films the returned pieces and books the receipt here, in its own transaction, so the
 * inspection, the receipt, the stock and the journal are one unit.
 */
export interface CourierApi {
  /** The order's live parcel, if it has one: its id and the codes printed on it. */
  parcelOfOrder(tx: Tx, orgId: string, orderId: string): Promise<ReturnParcel | null>;

  /**
   * Receive and inspect a returned parcel inside the caller's transaction: the receipt, the
   * courier event, the order's `receive_return` and its stock and journal. Throws the courier
   * module's own refusals (`CourierError`).
   */
  receiveReturn(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    consignmentId: string,
    input: ReceiveReturnInput,
  ): Promise<{ readonly receiptId: string; readonly orderStatus: string }>;
}

export interface ReturnParcel {
  readonly consignmentId: string;
  readonly consignmentNo: string | null;
  readonly trackingCode: string | null;
  readonly status: string;
  readonly courierId: string | null;
}

export const COURIER_API = Symbol('CourierApi');

/** The implementation. Registered under `COURIER_API` by `CourierModule`. */
@Injectable()
export class CourierApiService implements CourierApi {
  constructor(private readonly returns: ReturnsService) {}

  async parcelOfOrder(tx: Tx, orgId: string, orderId: string): Promise<ReturnParcel | null> {
    const row = await repo.consignmentByOrder(tx, orgId, orderId);
    if (row === undefined) return null;
    return {
      consignmentId: row.id,
      consignmentNo: row.consignment_no,
      trackingCode: row.tracking_code,
      status: row.status,
      courierId: row.courier_id,
    };
  }

  async receiveReturn(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    consignmentId: string,
    input: ReceiveReturnInput,
  ) {
    const received = await this.returns.receiveIn(tx, context, request, consignmentId, input);
    return { receiptId: received.receiptId, orderStatus: received.orderStatus };
  }
}
