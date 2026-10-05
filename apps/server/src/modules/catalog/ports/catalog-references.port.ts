import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import {
  ReferenceRegistry,
  type ReferenceChecker,
} from '../../../platform/references/references.js';

/**
 * Which modules use a catalog row, asked before it is deleted (M39a, D-621).
 *
 * The catalog is a leaf module: inventory, orders, the till, supply, couriers, promotions,
 * the website and marketing all import it, and it may read none of their tables
 * (invariant 12). Each of them registers a checker here when it starts (see
 * `*-references.binding.ts` in each module) and counts its own rows that point at the given
 * categories, lists, values, products or SKUs. `CatalogDeletesService` asks after locking
 * the rows, inside the delete's transaction.
 *
 * Kinds, and who answers for them:
 *
 * - `sku`: inventory (movements, levels, documents), orders (lines), the till (sale and
 *   return lines), supply (lines), couriers (return lines), promotions (flash sale items and
 *   discounts naming it), marketing (leads), the website (old ids, released).
 * - `product`: promotions and marketing (discounts and campaigns naming it), the website
 *   (old ids, released). Its SKUs are asked as `sku` as well.
 * - `category`: promotions (discounts naming it), the website (menu entries, movable; old
 *   ids, released).
 * - `attribute`, `attribute_value`: nobody outside the catalog; registered for symmetry.
 */
export type CatalogRefKind = 'category' | 'attribute' | 'attribute_value' | 'product' | 'sku';

/** Who is emptying a category, for the audit rows a module writes about its own rows. */
export interface MoveActor {
  readonly userId: string;
  readonly requestId: string | null;
}

export interface CatalogReferenceChecker extends ReferenceChecker<CatalogRefKind> {
  /**
   * A category is being emptied into `toId` (null: no category) before it is deleted. The
   * website re-points its menu entries at the target, or removes them when there is none,
   * writing an audit row with each removed entry's content.
   */
  moveCategory?(
    tx: Tx,
    orgId: string,
    fromId: string,
    toId: string | null,
    actor: MoveActor,
  ): Promise<number>;
}

@Injectable()
export class CatalogReferences extends ReferenceRegistry<CatalogRefKind> {
  private readonly movers: CatalogReferenceChecker[] = [];

  constructor() {
    super('catalog');
  }

  override register(checker: CatalogReferenceChecker): void {
    super.register(checker);
    if (checker.moveCategory !== undefined) this.movers.push(checker);
  }

  /** Every module's entries for `fromId` moved to `toId`; the number moved or removed. */
  async moveCategory(
    tx: Tx,
    orgId: string,
    fromId: string,
    toId: string | null,
    actor: MoveActor,
  ): Promise<number> {
    let moved = 0;
    for (const mover of this.movers) {
      moved += (await mover.moveCategory?.(tx, orgId, fromId, toId, actor)) ?? 0;
    }
    return moved;
  }
}
