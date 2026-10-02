import { deterministicUuid } from '@elysium/db';
import { businessDate } from '@elysium/domain';

import type { People } from './people.js';
import type { PreviewRuntime } from './runtime.js';

/**
 * What every part of the scenario shares: the application, the people, the brand, and
 * the ids the earlier parts made.
 */

const NAMESPACE = 'elysium-erp/preview';

/**
 * A client id the API keys its idempotency on (a supply entry, a payment, a cash entry, a
 * shift). Derived from the brand and a name, so a second run sends the same id and the
 * API answers with what the first run made instead of making it twice.
 */
export function previewId(orgId: string, name: string): string {
  return deterministicUuid(NAMESPACE, `${orgId}:${name}`);
}

/** `{ items: [...] }` or a bare array, as the list routes answer. */
export function itemsOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const items = (value as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

export interface Sku {
  readonly id: string;
  readonly skuCode: string;
  readonly pricePoisha: string;
  readonly productSlug: string;
  readonly size: string;
}

export interface Ids {
  hqBranchId: string;
  showroomBranchId: string;
  warehouseId: string;
  showroomId: string;
  transitId: string;
  /** Ledger account ids, by chart code. */
  accounts: Record<string, string>;
  /** `wallets.wallets` ids, by ledger code. */
  wallets: Record<string, string>;
  skus: Sku[];
  supplierIds: string[];
  demoCourierId: string;
  ownRiderId: string;
  campaignId: string;
  promoCode: string;
  employees: Record<string, string>;
}

export interface Summary {
  readonly notes: string[];
  trackingOrder?: { readonly orderNo: string; readonly phoneLast4: string; readonly slug: string };
  readonly counts: Record<string, number>;
}

export class Context {
  readonly ids: Ids = {
    hqBranchId: '',
    showroomBranchId: '',
    warehouseId: '',
    showroomId: '',
    transitId: '',
    accounts: {},
    wallets: {},
    skus: [],
    supplierIds: [],
    demoCourierId: '',
    ownRiderId: '',
    campaignId: '',
    promoCode: 'EID10',
    employees: {},
  };

  readonly summary: Summary = { notes: [], counts: {} };

  constructor(
    readonly runtime: PreviewRuntime,
    readonly people: People,
    readonly orgId: string,
    readonly orgSlug: string,
  ) {}

  id(name: string): string {
    return previewId(this.orgId, name);
  }

  /** Today in Asia/Dhaka, the date every posting route dates its work. */
  today(): string {
    return businessDate(new Date());
  }

  /** A Dhaka date `days` before today. */
  daysAgo(days: number): string {
    return businessDate(new Date(Date.now() - days * 86_400_000));
  }

  /** The Asia/Dhaka month `months` before this one, as `YYYY-MM`. */
  monthsAgo(months: number): string {
    const [year = 0, month = 1] = this.today().split('-').map(Number);
    const index = year * 12 + (month - 1) - months;
    return `${String(Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, '0')}`;
  }

  count(key: string, by = 1): void {
    this.summary.counts[key] = (this.summary.counts[key] ?? 0) + by;
  }

  note(text: string): void {
    this.summary.notes.push(text);
  }

  sku(productSlug: string, size: string): Sku {
    const found = this.ids.skus.find((sku) => sku.productSlug === productSlug && sku.size === size);
    if (found === undefined) throw new Error(`preview: no SKU ${productSlug}/${size}.`);
    return found;
  }

  /** Settle the worker's queue and the outbox before reading what they produce. */
  async settle(): Promise<void> {
    const pending = await this.runtime.settle();
    if (pending.jobs > 0 || pending.events > 0) {
      this.note(
        `Background work still pending after the wait: ${String(pending.jobs)} job(s), ${String(pending.events)} event(s).`,
      );
    }
  }
}
