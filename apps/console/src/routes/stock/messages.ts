import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';
import type { MessageKey } from '@elysium/i18n';

/**
 * The keys the stock screens render (M07).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, which is where the
 * bn/en parity guarantee lives: `bn` is typed as `Record<MessageKey, string>`,
 * so a key translated on one side only does not compile. This file used to hold
 * its own copies because that catalogue was being written by several agents at
 * once and a second write discarded the first.
 *
 * The ERP nouns Dhaka warehouse staff actually say in English — SKU, stock —
 * stay in English inside the Bangla string, because translating them slows a user
 * down.
 */

const STOCK_KEYS = [
  'stock.title',
  'stock.levels',
  'stock.search',
  'stock.allLocations',
  'stock.lowOnly',
  'stock.colSku',
  'stock.colProduct',
  'stock.colLocation',
  'stock.colOnHand',
  'stock.colReserved',
  'stock.colAvailable',
  'stock.colReorder',
  'stock.colWac',
  'stock.colValue',
  'stock.valuation',
  'stock.valuationUnits',
  'stock.valuationTotal',
  'stock.adjustments',
  'stock.adjustmentsHint',
  'stock.newAdjustment',
  'stock.direction',
  'stock.direction.loss',
  'stock.direction.gain',
  'stock.reason',
  'stock.reasonHint',
  'stock.location',
  'stock.sku',
  'stock.qty',
  'stock.submit',
  'stock.colStatus',
  'stock.colDate',
  'stock.colReason',
  'stock.status.pending_approval',
  'stock.status.posted',
  'stock.status.rejected',
  'stock.awaitingApproval',
  'stock.transfers',
  'stock.transfersHint',
  'stock.newTransfer',
  'stock.from',
  'stock.to',
  'stock.dispatch',
  'stock.receive',
  'stock.status.dispatched',
  'stock.status.received',
  'stock.status.cancelled',
  'stock.counts',
  'stock.countsHint',
  'stock.openCount',
  'stock.colSnapshot',
  'stock.colCounted',
  'stock.colVariance',
  'stock.countSubmit',
  'stock.countClose',
  'stock.status.open',
  'stock.status.submitted',
  'stock.status.closed',
  'stock.uncounted',
  'stock.reconciliations',
  'stock.reconciliationsHint',
  'stock.colChecked',
  'stock.colDrift',
  'stock.colCostDrift',
  'stock.noDrift',
  'stock.columns',
  'stock.previous',
  'stock.next',
  'stock.emptyTitle',
  'stock.emptyDetail',
  'stock.errorTitle',
  'stock.errorDetail',
  'stock.retry',
  'stock.sortAscending',
  'stock.sortDescending',
  'stock.deniedTitle',
  'stock.deniedDetail',
  'stock.saveFailed',
] as const satisfies readonly MessageKey[];

export type StockMessageKey = (typeof STOCK_KEYS)[number];

export const stockMessages = sectionCatalogue(STOCK_KEYS);
export const stockEn = stockMessages.en;

/**
 * The stock screens' lookup.
 *
 * Reads the locale from M05's provider, so the language switch in the shell
 * changes these strings too. Still throws on a missing value even though the key
 * type is narrow, because the dynamic call sites build the key out of a movement
 * status and cast it, and a cast that a newly added status has outgrown would
 * otherwise render nothing at all.
 */
export function useStockT(): (key: StockMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = stockMessages[locale][key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}
