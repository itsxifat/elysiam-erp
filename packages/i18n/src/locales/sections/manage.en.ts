/**
 * Deleting and archiving (M39a, D-621 to D-634; D-607's pattern): the English section.
 *
 * The shared Delete-or-archive dialog, and the delete, archive and restore controls on Catalog
 * setup, the Website's size charts and menu, Campaigns, Marketing, Suppliers, Branches and the
 * expense and income heads. A section of the catalogue in its own file, so the console ships it
 * with those screens instead of in the first download; for everything else it is part of
 * English.
 *
 * No string names a brand: the console is white-label (M31).
 */
const en = {
  'mg.close': 'Close',
  'mg.cancel': 'Cancel',
  'mg.loading': 'Checking what uses it…',
  'mg.failed': 'That could not be done. Nothing was changed; try again.',
  'mg.title': 'Delete or archive',
  'mg.titleNamed': 'Delete or archive {name}',
  'mg.unused': 'Nothing uses {name}. Deleting it removes it for good.',
  'mg.usedBy': '{name} is used by',
  'mg.cannotDelete': 'It cannot be deleted while these use it.',
  'mg.andMore': 'and more',
  'mg.delete': 'Delete',
  'mg.deleteForGood': 'Delete for good',
  'mg.archived': '{name} is archived: it is hidden from new work and kept wherever it is used.',
  'mg.archivedBadge': 'Archived',
  'mg.restore': 'Restore',
  'mg.showArchived': 'Show archived',
  'mg.deleted': 'Deleted.',

  // Empty and delete (categories, size charts).
  'mg.empty.title': 'Empty and delete',
  'mg.empty.categoryHelp':
    'Move its products to another category, move its subcategories up one level and point its menu entries at the new category; then it is deleted. Product codes already printed keep their old category letters.',
  'mg.empty.chartHelp': 'Give its products another size chart, or none; then it is deleted.',
  'mg.empty.target': 'Move them to',
  'mg.empty.noCategory': 'No category',
  'mg.empty.noChart': 'No size chart',
  'mg.empty.action': 'Move and delete',

  // Archive instead.
  'mg.archive.title': 'Archive instead',
  'mg.archive.help':
    'It is hidden from new work and kept on everything that already uses it. You can restore it at any time.',
  'mg.archive.category':
    'Its products leave the website until they are moved to another category or it is restored.',
  'mg.archive.value': 'New variants cannot use it; the variants that have it keep it.',
  'mg.archive.variants': 'Also archive the {n} variants with it',
  'mg.archive.location': 'A location is switched off only when it holds no stock.',
  'mg.archive.discount': 'Buyers can no longer use it. Restoring brings it back paused.',
  'mg.archive.flash':
    'It is switched off and leaves the list; the prices it sold at stay on record.',
  'mg.archive.action': 'Archive',

  // What uses a row, in plain words.
  'mg.reason.products': 'Products',
  'mg.reason.subcategories': 'Subcategories',
  'mg.reason.variants': 'Variants',
  'mg.reason.stock_movements': 'Stock movements',
  'mg.reason.stock_on_hand': 'Places holding stock',
  'mg.reason.stock_reserved': 'Places with stock held for orders',
  'mg.reason.stock_documents': 'Stock documents (counts, transfers, adjustments, stock in hand)',
  'mg.reason.order_lines': 'Order lines',
  'mg.reason.orders': 'Orders',
  'mg.reason.pos_lines': 'Till sales and returns',
  'mg.reason.pos_registers': 'Tills',
  'mg.reason.supply_lines': 'Supply lines',
  'mg.reason.supply_entries': 'Supply entries and returns',
  'mg.reason.supplier_payments': 'Supplier payments and advances',
  'mg.reason.supplier_notes': 'Notes',
  'mg.reason.courier_returns': 'Courier returns',
  'mg.reason.discounts': 'Discounts',
  'mg.reason.flash_sale_items': 'Flash sales',
  'mg.reason.redemptions': 'Times it was used',
  'mg.reason.flash_claims': 'Orders at the sale price',
  'mg.reason.menu_entries': 'Website menu entries',
  'mg.reason.web_locations': 'The website sells from it',
  'mg.reason.leads': 'Leads',
  'mg.reason.campaigns': 'Ad campaigns',
  'mg.reason.ad_spend': 'Ad spend entries',
  'mg.reason.messages_sent': 'Messages sent',
  'mg.reason.system_template': 'Sent by the system itself',

  // Catalog setup.
  'mg.setup.archiveList': 'Archive list',
  'mg.setup.valueActions': 'Actions for {name}',
  'mg.setup.rename': 'Rename',
  'mg.setup.order': 'Change order',
  'mg.setup.orderTitle': 'Order of {name}',
  'mg.setup.orderHelp': 'This is the order on every screen, picker and sticker.',
  'mg.setup.moveUp': 'Move {name} up',
  'mg.setup.moveDown': 'Move {name} down',
  'mg.setup.saveOrder': 'Save order',
  'mg.setup.manage': 'Delete or archive',
  'mg.setup.manageNamed': 'Delete or archive {name}',
  'mg.setup.restoreNamed': 'Restore {name}',
  'mg.setup.locationCodeFixed':
    'The code stays the same: stock records, transfers and counts already name it.',

  // The website's menu.
  'mg.menu.withChildren':
    'Deleting {name} also deletes the {n} items under it. The website stops showing them at once.',
  'mg.menu.alone': 'The website stops showing {name} at once.',

  // Branches (D-633).
  'mg.branch.manage': 'Manage branch',
  'mg.branch.title': 'Manage {name}',
  'mg.branch.name': 'Branch name',
  'mg.branch.codeFixed':
    'The code stays the same: it is in every order number and cash account already made.',
  'mg.branch.rename': 'Save name',
  'mg.branch.deactivate': 'Switch off',
  'mg.branch.reactivate': 'Switch back on',
  'mg.branch.inactive': 'Switched off',
  'mg.branch.never': 'A branch is never deleted: its sales, cash and staff history stay with it.',
  'mg.branch.ready': 'Nothing runs at this branch any more, so it can be switched off.',
  'mg.branch.blocked': 'It can be switched off once these are closed or moved:',
  'mg.branch.registers': 'Tills switched on',
  'mg.branch.openShifts': 'Open shifts',
  'mg.branch.walletsWithMoney': 'Wallets holding money',
  'mg.branch.employees': 'Employees',
  'mg.branch.stockPlaces': 'Places holding stock',

  // Expense and income heads (D-634).
  'mg.heads.title': 'Expense and income heads',
  'mg.heads.help':
    'The categories a cash entry is booked against. Add your own; a head you added can be renamed or archived. Heads are never deleted, so the books keep every entry against them.',
  'mg.heads.name': 'Head name',
  'mg.heads.kind': 'Kind',
  'mg.heads.expense': 'Expense',
  'mg.heads.income': 'Income',
  'mg.heads.add': 'Add head',
  'mg.heads.code': 'Code',
  'mg.heads.system': 'Standard',
  'mg.heads.systemHint': 'A standard head keeps its name and stays in use.',
  'mg.heads.renameTitle': 'Rename head',
  'mg.heads.archive': 'Archive',
  'mg.heads.restore': 'Restore',
  'mg.heads.save': 'Save',
} as const;

/** The keys of this section. */
export type ManageKey = keyof typeof en;

export { en };
