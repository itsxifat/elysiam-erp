import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';
import type { MessageKey } from '@elysium/i18n';

/**
 * The keys the supply screens render (M09).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, which is where the
 * bn/en parity guarantee lives: `bn` is typed as `Record<MessageKey, string>`,
 * so a key translated on one side only does not compile. This file used to hold
 * its own copies because that catalogue was being written by several agents at
 * once and a second write discarded the first.
 *
 * The ERP nouns Dhaka staff actually say in English — SKU, invoice, advance —
 * stay in English inside the Bangla string, because translating them slows a user
 * down.
 */

const SUPPLY_KEYS = [
  'supply.title',
  'supply.suppliers',
  'supply.entries',
  'supply.returns',
  'supply.payments',
  'supply.search',
  'supply.includeInactive',
  'supply.newSupplier',
  'supply.code',
  'supply.name',
  'supply.phone',
  'supply.terms',
  'supply.colDue',
  'supply.colAdvance',
  'supply.colStatus',
  'supply.active',
  'supply.inactive',
  'supply.deactivate',
  'supply.save',
  'supply.costWithheld',
  'supply.supplier',
  'supply.contacts',
  'supply.addContact',
  'supply.role',
  'supply.primary',
  'supply.notes',
  'supply.addNote',
  'supply.noteHint',
  'supply.documents',
  'supply.statement',
  'supply.statementHint',
  'supply.opening',
  'supply.closing',
  'supply.colDate',
  'supply.colSource',
  'supply.colAccount',
  'supply.colMemo',
  'supply.colDebit',
  'supply.colCredit',
  'supply.colRunning',
  'supply.truncated',
  'supply.newEntry',
  'supply.newEntryHint',
  'supply.newDraft',
  'supply.newDraftHint',
  'supply.location',
  'supply.invoice',
  'supply.sku',
  'supply.qty',
  'supply.unitCost',
  'supply.addLine',
  'supply.removeLine',
  'supply.total',
  'supply.receive',
  'supply.priceAndReceive',
  'supply.entryPosted',
  'supply.draftSaved',
  'supply.status.draft',
  'supply.status.received',
  'supply.lines',
  'supply.deleteDraft',
  'supply.reason',
  'supply.originalUnitCost',
  'supply.returnHint',
  'supply.newReturn',
  'supply.colCredited',
  'supply.colRelief',
  'supply.colVariance',
  'supply.wallet',
  'supply.amount',
  'supply.kind',
  'supply.kind.advance',
  'supply.kind.payment',
  'supply.memo',
  'supply.pay',
  'supply.paymentPosted',
  'supply.paymentHeld',
  'supply.payStatus.pending_approval',
  'supply.payStatus.posted',
  'supply.payStatus.rejected',
  'supply.applyAdvance',
  'supply.applyAdvanceHint',
  'supply.entry',
  'supply.colApplied',
  'supply.empty',
  'supply.errorTitle',
  'supply.errorDetail',
  'supply.retry',
  'supply.deniedTitle',
  'supply.deniedDetail',
  'supply.saveFailed',
] as const satisfies readonly MessageKey[];

export type SupplyMessageKey = (typeof SUPPLY_KEYS)[number];

export const supplyMessages = sectionCatalogue(SUPPLY_KEYS);
export const supplyEn = supplyMessages.en;

/**
 * The supply screens' lookup.
 *
 * Reads the locale from M05's provider, so the language switch in the shell
 * changes these strings too. Still throws on a missing value even though the key
 * type is narrow, because the dynamic call sites build the key out of a purchase
 * or payment status and cast it, and a cast that a newly added status has
 * outgrown would otherwise render nothing at all.
 */
export function useSupplyT(): (key: SupplyMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = supplyMessages[locale][key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}
