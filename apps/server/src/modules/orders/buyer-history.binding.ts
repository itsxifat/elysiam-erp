import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import { BuyerHistoryRegistry, type BuyerHistoryPort } from '../promo/ports/buyer-history.port.js';
import * as repo from './orders.repository.js';

/**
 * This module's answer to the promo module's first-order question (M35a, D-543).
 *
 * The promo module cannot import this one (this one imports it), and may not read
 * `sales.orders` (invariant 12), so this registers itself in the promo module's registry
 * at startup, the way the courier module registers its booking port with this one.
 */
@Injectable()
export class BuyerHistoryBinding implements BuyerHistoryPort, OnModuleInit {
  constructor(private readonly registry: BuyerHistoryRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  priorOrders(
    tx: Tx,
    orgId: string,
    customerId: string,
    excludingOrderId: string | null = null,
  ): Promise<number> {
    return repo.standingOrderCount(tx, orgId, customerId, excludingOrderId);
  }
}
