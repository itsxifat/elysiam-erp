import type { Tx } from '@elysium/db';
import type { UsageEntry, UsageExample, UsageReason } from '@elysium/contracts';

/**
 * "What uses this row?", asked of every module that may point at it (M39a, D-621).
 *
 * A row is deleted only when nothing references it, and the modules that reference it are
 * the ones that know: the catalog may not read `inventory.stock_movements` or
 * `sales.order_lines` (invariant 12), and those modules import the catalog, so it cannot
 * import them back. The shape is the one `BuyerHistoryRegistry` and `CourierBookingRegistry`
 * already use: the owner of a row exports a registry, and each module that points at the row
 * registers a checker in it when it starts. The owner asks the registry; each checker counts
 * rows **in its own tables only**, in the caller's transaction.
 *
 * One registry per owner (`CatalogReferences` for categories, lists, values, products and
 * SKUs; `LocationReferences`; `DiscountReferences`), all built on this class, so the import
 * graph stays what it is: the owner is the module the others already import.
 *
 * ## How a delete uses it
 *
 * 1. Lock the row (`select … for update`), so a new reference from elsewhere either commits
 *    before the lock (and is counted) or waits behind the delete (and then fails on the
 *    foreign key, or finds nothing to point at).
 * 2. `references(tx, orgId, kind, ids)`: every checker's counts. Anything that is not
 *    `movable` refuses the delete with `*_IN_USE`, naming the counts.
 * 3. `release(tx, orgId, kind, ids)`: each checker removes what exists only because of the
 *    row (an old site's id for it), then the owner deletes. A reference a checker missed is
 *    caught by the database's foreign key (23503), which every owner maps to the same
 *    `*_IN_USE` code.
 */

/** One module's answer: how many of its rows use the ids, and a few names to show. */
export interface ReferenceUse {
  readonly reason: UsageReason;
  readonly count: number;
  readonly examples?: readonly UsageExample[];
  /** True when "Empty and delete" moves these (a category's products); default false. */
  readonly movable?: boolean;
}

export interface ReferenceChecker<Kind extends string> {
  /** The module answering, for messages and tests. */
  readonly module: string;
  /** Counts of this module's rows that point at any of `ids`. Zero counts may be left out. */
  references(
    tx: Tx,
    orgId: string,
    kind: Kind,
    ids: readonly string[],
  ): Promise<readonly ReferenceUse[]>;
  /**
   * Remove this module's rows that exist only because of the rows being deleted (an old
   * site's id for a product). Called after `references` found nothing that keeps them, in
   * the same transaction, before the owner deletes. Never removes anything with history.
   */
  release?(tx: Tx, orgId: string, kind: Kind, ids: readonly string[]): Promise<void>;
}

/** How many examples a usage report names per reason. */
export const USAGE_EXAMPLES = 5;

export class ReferenceRegistry<Kind extends string> {
  private readonly checkers: ReferenceChecker<Kind>[] = [];

  constructor(private readonly owner: string) {}

  register(checker: ReferenceChecker<Kind>): void {
    if (this.checkers.some((existing) => existing.module === checker.module)) {
      throw new Error(`${checker.module} already answers the ${this.owner} references`);
    }
    this.checkers.push(checker);
  }

  /** Which modules answer, for the test that every module that should, does. */
  modules(): readonly string[] {
    return this.checkers.map((checker) => checker.module).sort();
  }

  /**
   * Every checker's counts, merged by reason, zeros dropped.
   *
   * Sequential on purpose: one transaction is one connection, and the driver would queue
   * parallel queries anyway.
   */
  async references(
    tx: Tx,
    orgId: string,
    kind: Kind,
    ids: readonly string[],
  ): Promise<UsageEntry[]> {
    if (ids.length === 0) return [];
    const found: ReferenceUse[] = [];
    for (const checker of this.checkers) {
      found.push(...(await checker.references(tx, orgId, kind, ids)));
    }
    return mergeUses(found);
  }

  async release(tx: Tx, orgId: string, kind: Kind, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const checker of this.checkers) {
      await checker.release?.(tx, orgId, kind, ids);
    }
  }
}

/** Uses with the same reason added together, examples deduplicated, zeros dropped. */
export function mergeUses(uses: readonly ReferenceUse[]): UsageEntry[] {
  const byReason = new Map<
    UsageReason,
    { count: number; examples: UsageExample[]; movable: boolean }
  >();
  for (const use of uses) {
    if (use.count <= 0) continue;
    const entry = byReason.get(use.reason) ?? { count: 0, examples: [], movable: true };
    entry.count += use.count;
    entry.movable = entry.movable && use.movable === true;
    for (const example of use.examples ?? []) {
      if (entry.examples.length >= USAGE_EXAMPLES) break;
      if (!entry.examples.some((known) => known.id === example.id)) entry.examples.push(example);
    }
    byReason.set(use.reason, entry);
  }
  return [...byReason.entries()].map(([reason, entry]) => ({
    reason,
    count: entry.count,
    examples: entry.examples,
    movable: entry.movable,
  }));
}

/** The uses that keep a row: everything "Empty and delete" cannot move. */
export function blocking(uses: readonly UsageEntry[]): UsageEntry[] {
  return uses.filter((use) => !use.movable);
}

const REASON_WORDS: Readonly<Record<UsageReason, readonly [string, string]>> = {
  products: ['product', 'products'],
  subcategories: ['subcategory', 'subcategories'],
  variants: ['variant', 'variants'],
  stock_movements: ['stock movement', 'stock movements'],
  stock_on_hand: ['place holding stock', 'places holding stock'],
  stock_reserved: ['reservation', 'reservations'],
  stock_documents: ['stock document', 'stock documents'],
  order_lines: ['order line', 'order lines'],
  orders: ['order', 'orders'],
  pos_lines: ['till sale or return line', 'till sale or return lines'],
  pos_registers: ['till', 'tills'],
  supply_lines: ['supply line', 'supply lines'],
  supply_entries: ['supply entry or return', 'supply entries or returns'],
  supplier_payments: ['supplier payment', 'supplier payments'],
  supplier_notes: ['note', 'notes'],
  courier_returns: ['courier return line', 'courier return lines'],
  discounts: ['discount', 'discounts'],
  flash_sale_items: ['flash sale', 'flash sales'],
  redemptions: ['redemption', 'redemptions'],
  flash_claims: ['flash sale order line', 'flash sale order lines'],
  menu_entries: ['menu entry', 'menu entries'],
  web_locations: ['website stock setting', 'website stock settings'],
  campaign_links: ['campaign link', 'campaign links'],
  marketplace_holds: ['ncom.bd stock hold', 'ncom.bd stock holds'],
  packing_scans: ['packing scan', 'packing scans'],
  inbox_interests: ['customer interest in the inbox', 'customer interests in the inbox'],
  desk_profiles: ['staff member whose hub it is', 'staff members whose hub it is'],
  packing_terminals: ['label or packing terminal at it', 'label or packing terminals at it'],
  leads: ['lead', 'leads'],
  campaigns: ['ad campaign', 'ad campaigns'],
  ad_spend: ['ad spend entry', 'ad spend entries'],
  messages_sent: ['message sent', 'messages sent'],
  system_template: ['system message', 'system messages'],
  ledger_lines: ['entry in the books', 'entries in the books'],
};

/** "3 stock movements, 2 order lines and 1 discount", for an error's detail. */
export function describeUses(uses: readonly UsageEntry[]): string {
  const parts = uses.map((use) => {
    const [one, many] = REASON_WORDS[use.reason];
    return `${String(use.count)} ${use.count === 1 ? one : many}`;
  });
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

/**
 * Did the database refuse a delete because a row still points at it?
 *
 * SQLSTATE 23503 on the deleting side: PostgreSQL's own "update or delete on table … violates
 * foreign key constraint", or one of 0119's guards (`*_IN_USE: …`). The inserting side of a
 * 23503 ("insert or update on table …") is a different mistake and is left alone, so a
 * product created in a category that is not there never reads as "in use".
 */
export function isStillReferenced(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code !== '23503') continue;
    const message = current.message;
    if (message.startsWith('update or delete on table') || /^[A-Z]+_IN_USE: /.test(message)) {
      return true;
    }
  }
  return false;
}
