import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';
import type { MessageKey } from '@elysium/i18n';

/**
 * The keys the catalog screens render (M06).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, which is where the
 * bn/en parity guarantee lives: `bn` is typed as `Record<MessageKey, string>`,
 * so a key translated on one side only does not compile. This file used to hold
 * its own copies because that catalogue was being written by several agents at
 * once and a second write discarded the first.
 *
 * The Bangla is real Bangla rather than a placeholder, and the ERP nouns Dhaka
 * ops staff say in English (SKU, barcode) stay in English inside the Bangla
 * string, because translating them would slow a user down rather than help them.
 *
 * `satisfies readonly MessageKey[]` keeps a typo in the list a build error, and
 * `CatalogMessageKey` stays narrower than `MessageKey` so these screens cannot
 * reach for an unrelated section's string.
 */

const CATALOG_KEYS = [
  'catalog.title',
  'catalog.products',
  'catalog.structure',
  'catalog.search',
  'catalog.searchHint',
  'catalog.allCategories',
  'catalog.allStatuses',
  'catalog.status.draft',
  'catalog.status.active',
  'catalog.status.archived',
  'catalog.colProduct',
  'catalog.colCategory',
  'catalog.colStatus',
  'catalog.colSkus',
  'catalog.colPrice',
  'catalog.colCode',
  'catalog.colVariant',
  'catalog.colBarcode',
  'catalog.emptyTitle',
  'catalog.emptyDetail',
  'catalog.emptyDetailReadOnly',
  'catalog.errorTitle',
  'catalog.errorDetail',
  'catalog.retry',
  'catalog.columns',
  'catalog.previous',
  'catalog.next',
  'catalog.sortAscending',
  'catalog.sortDescending',
  'catalog.deniedTitle',
  'catalog.deniedDetail',
  'catalog.newProduct',
  'catalog.productName',
  'catalog.productSlug',
  'catalog.productCategory',
  'catalog.productPrice',
  'catalog.productStatus',
  'catalog.create',
  'catalog.cancel',
  'catalog.save',
  'catalog.variants',
  'catalog.variantMatrix',
  'catalog.addVariants',
  'catalog.addVariantsHelp',
  'catalog.variantsAdded',
  'catalog.variantsNoneAdded',
  'catalog.variantsOrphaned',
  'catalog.bulkPrice',
  'catalog.bulkPriceHelp',
  'catalog.priceReason',
  'catalog.priceHistory',
  'catalog.priceFrom',
  'catalog.priceTo',
  'catalog.priceWhen',
  'catalog.priceWho',
  'catalog.priceNoHistory',
  'catalog.images',
  'catalog.imagesHelp',
  'catalog.imageAlt',
  'catalog.imageMoveUp',
  'catalog.imageMoveDown',
  'catalog.imageRemove',
  'catalog.labels',
  'catalog.labelsHelp',
  'catalog.labelsCopies',
  'catalog.labelsShowPrice',
  'catalog.labelsDownload',
  'catalog.import',
  'catalog.importHelp',
  'catalog.importFile',
  'catalog.importDryRun',
  'catalog.importCommit',
  'catalog.importRows',
  'catalog.importWillChange',
  'catalog.importUnchanged',
  'catalog.importProblems',
  'catalog.importLine',
  'catalog.importColumn',
  'catalog.importMessage',
  'catalog.importBlocked',
  'catalog.importApplied',
  'catalog.categories',
  'catalog.attributes',
  'catalog.newCategory',
  'catalog.newAttribute',
  'catalog.newValue',
  'catalog.code',
  'catalog.codeHelp',
  'catalog.label',
  'catalog.parent',
  'catalog.noParent',
  'catalog.attributeKind',
  'catalog.kind.size',
  'catalog.kind.colour',
  'catalog.kind.custom',
  'catalog.isVariant',
  'catalog.isVariantHelp',
] as const satisfies readonly MessageKey[];

export type CatalogMessageKey = (typeof CATALOG_KEYS)[number];

export const catalogMessages = sectionCatalogue(CATALOG_KEYS);
export const catalogEn = catalogMessages.en;
export const catalogBn = catalogMessages.bn;

/**
 * The catalog screens' lookup.
 *
 * Reads the locale from M05's provider, so the language switch in the shell
 * changes these strings too. Still throws on a missing value even though the key
 * type is narrow, because the dynamic call sites build the key out of a domain
 * enum value and cast it, and a cast that a newly added value has outgrown would
 * otherwise render nothing at all.
 */
export function useCatalogT(): (key: CatalogMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = catalogMessages[locale][key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}
