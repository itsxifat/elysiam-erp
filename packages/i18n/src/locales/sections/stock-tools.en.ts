/**
 * Stickers, scanning and stock in hand (M38a, D-601 to D-607): the English section.
 *
 * A section of the catalogue in its own file, so the console ships it with the screens that
 * use it (the new-product form, the product page, the stock screens) instead of in the first
 * download (D-607). For everything else it is part of English: `MessageKey` includes these
 * keys, `messages.en` holds them, and `scripts/check-i18n.mjs` checks them with the rest.
 *
 * No string names a brand: the console is white-label (M31), and a brand's own name comes
 * from its organization row.
 */
const en = {
  'st.close': 'Close',
  'st.cancel': 'Cancel',
  'st.saveFailed': 'That could not be saved. Nothing was changed; try again.',

  'st.col.item': 'Item',
  'st.col.pieces': 'Pieces',
  'st.col.costPerPiece': 'Cost per piece (৳)',
  'st.col.location': 'Location',
  'st.col.status': 'Status',
  'st.col.value': 'Value',
  'st.col.when': 'When',
  'st.col.actions': 'Actions',

  // Scanning (D-605).
  'st.scan.label': 'Scan or type a barcode',
  'st.scan.hint': 'Each scan adds one piece. Typing a code and pressing Enter works too.',
  'st.scan.camera': 'Scan with camera',
  'st.scan.cameraTitle': 'Scan with the camera',
  'st.scan.cameraHelp': 'Hold the sticker inside the frame. It is read as soon as it is sharp.',
  'st.scan.cameraFailed':
    'The camera could not be opened. Allow camera access, or type the code instead.',
  'st.scan.added': 'Added:',
  'st.scan.notThisProduct': 'That sticker belongs to another product.',
  'st.scan.notHere': 'None at this location:',
  'st.scan.notFound': 'No product in this brand has that barcode.',
  'st.scan.failed': 'The barcode could not be looked up. Try again.',
  'st.scan.opening': 'Opening the scanned product…',
  'st.scan.cannotOpen': 'Your role cannot open products.',

  // Stickers (D-604).
  'st.stickers.title': 'Print stickers',
  'st.stickers.help':
    'One sticker per piece. Choose what you print on; the price can be left off the tag.',
  'st.stickers.medium': 'Print on',
  'st.stickers.medium.thermal_38x25': 'Thermal roll, 38 × 25 mm',
  'st.stickers.medium.thermal_40x30': 'Thermal roll, 40 × 30 mm',
  'st.stickers.medium.thermal_50x25': 'Thermal roll, 50 × 25 mm',
  'st.stickers.medium.a4_3x8': 'A4 sheet, 3 × 8 (24 a sheet)',
  'st.stickers.medium.a4_4x10': 'A4 sheet, 4 × 10 (40 a sheet)',
  'st.stickers.startAt': 'Start at position',
  'st.stickers.startAtHint': 'Skip stickers already used on this sheet. Positions run 1 to',
  'st.stickers.showPrice': 'Print the price on the sticker',
  'st.stickers.caption': 'Stickers to print, per item',
  'st.stickers.count': 'Stickers',
  'st.stickers.total': 'Stickers in all:',
  'st.stickers.print': 'Print',
  'st.stickers.parts':
    'More than a thousand stickers come as several files. Print them one after another.',
  'st.stickers.part': 'Part',
  'st.stickers.ready': 'Your stickers are ready. If no new tab opened, open or download them here.',
  'st.stickers.open': 'Open',
  'st.stickers.download': 'Download',
  'st.stickers.failed': 'The stickers could not be produced. Try again.',
  'st.stickers.sectionTitle': 'Barcode stickers',
  'st.stickers.sectionHelp':
    'Print a sticker for every piece: each variant starts at the pieces in stock. Change any count before printing.',
  'st.stickers.choose': 'Print stickers',
  'st.stickers.pick': 'Choose for stickers:',
  'st.stickers.pickColumn': 'Choose for stickers',
  'st.stickers.printPicked': 'Print stickers for the chosen rows',
  'st.stickers.clearPicked': 'Clear the choice',

  // Editing a product (D-601).
  'st.edit.slug': 'Web address',
  'st.edit.slugHint':
    'Lower-case letters, digits and dashes. The old address keeps leading to the product.',

  // Barcodes on the product page (D-606).
  'st.barcode.copy': 'Copy barcode',
  'st.barcode.copied': 'Copied',
  'st.barcode.print': 'Print stickers for',

  // Photos in the new-product form (D-601).
  'st.photos.add': 'Add photos',
  'st.photos.help':
    'Choose several at once. Drag to reorder; the first is the cover. Crop any to the shop’s shape.',
  'st.photos.notImage': 'Only JPEG, PNG and WebP photos can be added; the rest were left out.',
  'st.photos.order': 'Photos, in the order they show',
  'st.photos.photo': 'Photo',
  'st.photos.cover': 'Cover',
  'st.photos.moveLeft': 'Move earlier: photo',
  'st.photos.moveRight': 'Move later: photo',
  'st.photos.makeCover': 'Make the cover: photo',
  'st.photos.crop': 'Crop to the shop’s shape: photo',
  'st.photos.remove': 'Remove photo',
  'st.photos.cropTitle': 'Crop to the shop’s shape',
  'st.photos.cropHelp':
    'Drag the photo, or use the arrow keys, until the part that should show sits in the frame. Zoom in to fill it.',
  'st.photos.cropFrame': 'The part of the photo that will show',
  'st.photos.zoom': 'Zoom',
  'st.photos.cropSave': 'Use this crop',
  'st.photos.cropFailed': 'That photo could not be cropped here. Add it as it is, or try another.',

  // The new-product form (D-601, D-602).
  'st.new.gridHelp':
    'Leave a price blank to use the selling price. Pieces are what you have of each variant now; leave blank for none.',
  'st.new.stock': 'Stock',
  'st.new.stockFrom': 'Where the pieces come from',
  'st.new.inHand': 'Already in hand (opening stock)',
  'st.new.fromSupplier': 'Received from a supplier',
  'st.new.inHandHelp':
    'Stock the brand already holds. Each piece is entered at what it cost; it counts as the brand’s opening stock.',
  'st.new.inHandHelpDraft':
    'Stock the brand already holds. You count the pieces; accounts enters what each cost before it posts.',
  'st.new.inHandMemo': 'Opening stock with a new product',
  'st.new.windowClosed':
    'Opening stock is closed for this brand, so new pieces are received from a supplier.',
  'st.new.costHint': 'For every variant; a cost in the table above overrides it.',
  'st.new.costMissing': 'Every variant with pieces needs a cost per piece above zero.',
  'st.new.website': 'Website details',
  'st.new.websiteHint': 'Optional: how the product shows on the website.',
  'st.new.creating': 'Creating the product…',
  'st.new.uploading': 'Uploading photo',
  'st.new.savingWeb': 'Saving the website details…',
  'st.new.savingStock': 'Entering the stock…',
  'st.new.doneTitle': 'Product created',
  'st.new.done': 'The product, its sizes and colours, photos and stock are saved.',
  'st.new.donePieces': 'Pieces entered:',
  'st.new.doneNoStock': 'No stock was entered. Stickers start at one per variant.',
  'st.new.printStickers': 'Print stickers',
  'st.new.another': 'Add another product',

  // Receiving on the product page (D-602).
  'st.receive.inHandHelp':
    'Stock the brand already holds, at what each piece cost. It counts as opening stock.',
  'st.receive.inHandHelpDraft':
    'Stock the brand already holds. Count the pieces; accounts enters the cost and posts it.',

  // Counting by scanning (D-606).
  'st.count.scanLabel': 'Scan each piece on the shelf',
  'st.count.note': 'Why the count was typed',
  'st.count.noteHint': 'A figure typed over a counted one needs a reason, kept with the count.',

  // Stock in hand and the opening stock window (D-602).
  'st.inHand.tab': 'Stock in hand',
  'st.inHand.title': 'Stock in hand',
  'st.inHand.help':
    'The stock the brand already holds when it starts here, counted in at what each piece cost.',
  'st.inHand.deniedTitle': 'Stock is not part of your role',
  'st.inHand.deniedDetail': 'Ask an admin if you need to see the stock.',
  'st.inHand.newEntry': 'Count stock in',
  'st.inHand.newHelp':
    'Choose where the pieces are, scan each one (or add a product and type its quantities), give the cost per piece, then post.',
  'st.inHand.newHelpDraft':
    'Choose where the pieces are and scan each one (or add a product and type its quantities). Accounts enters the costs and posts it.',
  'st.inHand.costHint': 'For every line; a cost on a line overrides it.',
  'st.inHand.memo': 'Note (shelf, carton…)',
  'st.inHand.addProduct': 'Add a product',
  'st.inHand.addProductHint': 'Type three letters of its name',
  'st.inHand.variants': 'variants',
  'st.inHand.lines': 'Pieces in this entry',
  'st.inHand.removeLine': 'Remove',
  'st.inHand.post': 'Post stock in hand',
  'st.inHand.saveDraft': 'Save for accounts',
  'st.inHand.piecesTotal': 'pieces',
  'st.inHand.entries': 'Entries',
  'st.inHand.none': 'No stock in hand entered yet.',
  'st.inHand.draft': 'Waiting for costs',
  'st.inHand.posted': 'Posted',
  'st.inHand.priceAndPost': 'Enter costs and post',
  'st.inHand.printEntry': 'Print stickers for this entry',
  'st.inHand.deleteDraft': 'Delete draft',
  'st.inHand.deleteDraftHelp': 'The counted quantities are thrown away. Nothing was posted.',
  'st.inHand.priceTitle': 'Enter what each piece cost',
  'st.inHand.priceHelp': 'Every line needs a cost per piece above zero, in taka.',
  'st.inHand.changed':
    'Someone changed this draft after you opened it. Check the pieces below, then post again.',
  'st.inHand.reversed': 'Reversed',
  'st.inHand.reverse': 'Reverse this entry',
  'st.inHand.reverseTitle': 'Reverse this entry?',
  'st.inHand.reverseHelp':
    'For an entry made by mistake, such as a shelf counted in twice. A second admin approves it; then its pieces come out of stock and the books are reversed. If the products have since been costed together with other stock, correct it with a stock count instead.',
  'st.inHand.reverseReason': 'Why it is being reversed',
  'st.inHand.reverseAsk': 'Ask to reverse',
  'st.inHand.reverseSent': 'Sent for approval. The entry is reversed once a second admin approves.',
  'st.inHand.reverseBlocked':
    'This entry cannot be reversed now: a reversal is already waiting, or its products have been costed together with other stock since. Correct it with a stock count.',
  'st.window.title': 'Opening stock',
  'st.window.open': 'Open',
  'st.window.closed': 'Closed',
  'st.window.openHelp':
    'Stock the brand already holds can be counted in. Close this once everything is in: after that, stock comes only from suppliers, transfers, returns and approved adjustments.',
  'st.window.closedHelp':
    'Everything was counted in. Stock now comes only from suppliers, transfers, returns and approved adjustments.',
  'st.window.closedOn': 'Closed',
  'st.window.close': 'Close opening stock',
  'st.window.closeTitle': 'Close opening stock?',
  'st.window.closeHelp':
    'From now on stock can only arrive from a supplier, a transfer, a return or an approved adjustment. Reopening needs a second admin’s approval.',
  'st.window.askReopen': 'Ask to reopen',
  'st.window.reopenTitle': 'Ask to reopen opening stock',
  'st.window.reopenHelp':
    'A second admin decides. Say what was found, so they can judge whether it is opening stock.',
  'st.window.reason': 'Why it needs reopening',
  'st.window.reopenPending': 'A request to reopen is waiting for a second admin.',
} as const;

/** The keys of this section. */
export type StockToolsKey = keyof typeof en;

export { en };
