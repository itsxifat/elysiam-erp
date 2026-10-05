/**
 * Variant prices, buying prices and product management (M39b, D-635 to D-646): the English
 * section.
 *
 * A section of the catalogue in its own file (D-607), so the console ships it with the screens
 * that use it (the new-product form, the product page, the product list, the receive dialog,
 * Supply → Entries and Supply → Buying prices) instead of in the first download. For everything
 * else it is part of English: `MessageKey` includes these keys, `messages.en` holds them, and
 * `scripts/check-i18n.mjs` checks them with the rest.
 *
 * No string names a brand: the console is white-label (M31).
 */
const en = {
  'cp.cancel': 'Cancel',
  'cp.close': 'Close',
  'cp.save': 'Save',
  'cp.saveFailed': 'That could not be saved. Nothing was changed; try again.',
  'cp.none': 'None',
  'cp.all': 'All',
  'cp.selected': 'selected',
  'cp.clearSelection': 'Clear selection',
  'cp.selectAll': 'Select every variant',
  'cp.selectRow': 'Select',

  // Columns.
  'cp.col.regular': 'Regular price (৳)',
  'cp.col.cost': 'Cost',
  'cp.col.regularShort': 'Regular',
  'cp.col.avgCost': 'Avg. cost',
  'cp.col.lastCost': 'Last bought',
  'cp.col.margin': 'Margin',
  'cp.col.standardCost': 'Standard buying price (৳)',
  'cp.col.weight': 'Weight (g)',
  'cp.col.price': 'Price (৳)',

  // The new-product grid (D-635).
  'cp.new.quickFills': 'Quick prices',
  'cp.new.quickFillsHelp':
    'Type a price for a size or a colour and every matching variant takes it. A price typed in a row wins over both.',
  'cp.new.bySize': 'Price by size',
  'cp.new.byColour': 'Price by colour',
  'cp.new.ownPrice': 'Own price',
  'cp.new.setSelected': 'Set for the selected variants',
  'cp.new.apply': 'Apply',
  'cp.new.copyDown': 'Copy this row to the rows below',
  'cp.new.pricePositive': 'Prices are above zero, in taka with up to two decimals.',
  'cp.new.regularAbove': 'A regular price is above the selling price, or left blank.',
  'cp.new.weight': 'Weight per piece (g)',
  'cp.new.weightHint': 'Couriers are told this. Leave it blank for their default.',
  'cp.new.weightInvalid': 'A weight is whole grams, from 1 to 100,000.',
  'cp.new.sizeChart': 'Size chart',
  'cp.new.sizeChartFromCategory': 'from the category',
  'cp.new.costEach': 'Each variant can have its own cost. The cost above fills any left blank.',

  // The product page (D-636).
  'cp.hub.editPrices': 'Edit prices',
  'cp.hub.stockValue': 'Stock value',
  'cp.hub.bulkTitle': 'Change many prices',
  'cp.hub.bulkHelp':
    'Choose variants (tick rows, or a size or colour), say what to do, and preview. Nothing is saved until you save.',
  'cp.hub.choose': 'Choose',
  'cp.hub.field': 'Which price',
  'cp.hub.field.price': 'Selling price',
  'cp.hub.field.compareAt': 'Regular price',
  'cp.hub.rule': 'Change',
  'cp.hub.rule.set': 'Set to (৳)',
  'cp.hub.rule.add': 'Add (৳)',
  'cp.hub.rule.subtract': 'Subtract (৳)',
  'cp.hub.rule.up': 'Raise by (%)',
  'cp.hub.rule.down': 'Lower by (%)',
  'cp.hub.amount': 'Amount',
  'cp.hub.round': 'Round to',
  'cp.hub.round.none': 'No rounding',
  'cp.hub.preview': 'Preview',
  'cp.hub.previewCount': 'prices will change',
  'cp.hub.previewNothing': 'Nothing changes for the chosen variants.',
  'cp.hub.problem.notPositive': 'would be zero or less',
  'cp.hub.problem.tooLarge': 'would be too large',
  'cp.hub.problem.regular': 'would leave the regular price at or below the price',
  'cp.hub.amountInvalid': 'Type an amount: taka for a price, a percentage for a percent.',
  'cp.hub.reason': 'Why (kept in the price history)',
  'cp.hub.reasonDefault': 'Changed on the product page',
  'cp.hub.saveCount': 'Save prices',
  'cp.hub.marginHelp':
    'Margin is worked out on this screen from the selling price and the average cost (or the last buying price).',

  // Buying prices on the product page (D-638).
  'cp.buy.title': 'Buying prices',
  'cp.buy.help':
    'The standard buying price fills the next receipt of each variant; the receipt can still say otherwise. The average cost moves only when stock is received.',
  'cp.buy.fillAll': 'Same for all',
  'cp.buy.fill': 'Fill',
  'cp.buy.saved': 'Buying prices saved.',
  'cp.buy.lastFrom': 'from',
  'cp.buy.never': 'Never bought',
  'cp.buy.spreadsheet': 'Spreadsheet of buying prices',

  // Variant dialog (D-644, D-645).
  'cp.variant.edit': 'Edit variant',
  'cp.variant.editHelp':
    "A supplier's own barcode replaces the ERP's on this variant. Stickers already printed keep the old one.",
  'cp.variant.barcode': 'Barcode',
  'cp.variant.barcodeHint':
    "Scan or type the supplier's barcode. Leave it blank to print the SKU code.",
  'cp.variant.weightHint': "Leave it blank to use the product's weight.",
  'cp.variant.archiveStock': 'This variant still has pieces in stock',
  'cp.variant.archiveHeld': 'held for orders',
  'cp.variant.archiveHeldRefused':
    'Orders hold pieces of this variant. Dispatch or cancel those orders before archiving it.',

  // Duplicate (D-641).
  'cp.dup.action': 'Duplicate',
  'cp.delete': 'Delete',
  'cp.dup.title': 'Duplicate this product',
  'cp.dup.help':
    'Copies the category, description, variants and their prices, photos, website details and size chart. No stock, no buying prices, no history. The copy starts as a draft.',
  'cp.dup.name': 'Name of the copy',
  'cp.dup.copySuffix': 'copy',
  'cp.dup.submit': 'Duplicate',

  // Sizes and colours later (D-639).
  'cp.extend.title': 'Sizes and colours',
  'cp.extend.help':
    'Tick a size or colour to add its variants; untick one to stop selling it in every colour (its stock stays and can still be moved or written off).',
  'cp.extend.mainPrice': 'Price for new variants (৳)',
  'cp.extend.mainPriceHint':
    'A new variant takes the price of the same size in another colour; otherwise this one.',
  'cp.extend.willAdd': 'Will add',
  'cp.extend.willArchive': 'Will stop selling',
  'cp.extend.willRestore': 'Will sell again',
  'cp.extend.orphans':
    'These variants have no colour and will not match the new ones. Archive them? Their stock stays.',
  'cp.extend.archiveOrphans': 'Archive them',
  'cp.extend.skippedArchived':
    '{n} new combinations are left out because a size or colour in them is archived. Restore it in Catalog setup to add them.',
  'cp.extend.submit': 'Save sizes and colours',
  'cp.extend.done': 'Saved.',
  'cp.extend.nothing': 'Nothing to change yet: tick or untick a size or colour.',
  'cp.extend.pieces': 'pieces in stock',

  // Photos (D-643).
  'cp.photo.colour': 'Colour',
  'cp.photo.anyColour': 'Every colour',

  // Price history (D-636).
  'cp.history.title': 'Price history',
  'cp.history.none': 'No price changes yet.',
  'cp.history.price': 'Price',
  'cp.history.regular': 'Regular price',

  // The product list (D-642).
  'cp.list.photo': 'Photo',
  'cp.list.website': 'Website',
  'cp.list.shown': 'Shown',
  'cp.list.hidden': 'Hidden',
  'cp.list.stock': 'Stock',
  'cp.list.actions': 'Actions for',
  'cp.list.edit': 'Open',
  'cp.list.show': 'Show on website',
  'cp.list.hide': 'Hide from website',
  'cp.list.archive': 'Archive',
  'cp.list.restore': 'Restore',
  'cp.list.moveTo': 'Move to category',
  'cp.list.setChart': 'Set size chart',
  'cp.list.noChart': 'No size chart',
  'cp.list.stickers': 'Print stickers',
  'cp.list.done': 'Done.',
  'cp.list.selectPage': 'Select every product on this page',

  // The receive dialog and supply entries (D-637).
  'cp.receive.sameForAll': 'Same cost for all (৳)',
  'cp.receive.sameForAllHint':
    'Used for every variant you have not typed a cost for, in place of the filled-in ones.',
  'cp.receive.prefilled': 'Filled from the standard or last buying price; change any of them.',
  'cp.receive.source.supplierStandard': "this supplier's standard",
  'cp.receive.source.standard': 'standard',
  'cp.receive.source.last': 'last bought',
  'cp.receive.archivedScan':
    'That variant is archived. Restore it on the product page to receive it.',
  'cp.receive.costMissing': 'Every variant with pieces needs a cost.',
  'cp.entries.addProduct': 'Add a product',
  'cp.entries.addProductHint':
    'Type three letters of a product name; every active variant becomes a line.',
  'cp.entries.addAll': 'Add its variants',
  'cp.entries.cancelPricing': 'Cancel',
  'cp.entries.fillBlank': 'Fill blanks',

  // Supply → Buying prices (D-638).
  'cp.costs.title': 'Buying prices',
  'cp.costs.help':
    "Every variant's standard buying price, for any supplier or for one. They fill the next receipt; the receipt's own cost is what enters the books.",
  'cp.costs.export': 'Download the spreadsheet',
  'cp.costs.exportHelp':
    'One row per variant (and per supplier with its own price). Fill standard_cost_taka, leave a row blank to keep it, and upload it back.',
  'cp.costs.import': 'Upload a spreadsheet',
  'cp.costs.check': 'Check the file',
  'cp.costs.commit': 'Import',
  'cp.costs.willSet': 'buying prices will be set',
  'cp.costs.skipped': 'rows left blank',
  'cp.costs.problems': 'Problems to fix first',
  'cp.costs.line': 'Line',
  'cp.costs.imported': 'Imported.',
  'cp.costs.chooseFile': 'Choose a CSV file',
} as const;

export type CatalogPricingKey = keyof typeof en;

export { en };
