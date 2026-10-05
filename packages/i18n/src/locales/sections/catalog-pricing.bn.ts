import type { CatalogPricingKey } from './catalog-pricing.en.js';

/**
 * Variant prices, buying prices and product management (M39b): the Bangla section, typed
 * against the English one, so a key on one side only does not compile.
 *
 * The words staff in Dhaka say in English stay in English (SKU, barcode, variant, CSV).
 */
const bn: Record<CatalogPricingKey, string> = {
  'cp.cancel': 'বাতিল',
  'cp.close': 'বন্ধ করুন',
  'cp.save': 'সেভ করুন',
  'cp.saveFailed': 'সেভ করা যায়নি। কিছুই বদলায়নি; আবার চেষ্টা করুন।',
  'cp.none': 'কোনোটি নয়',
  'cp.all': 'সব',
  'cp.selected': 'টি বাছাই করা',
  'cp.clearSelection': 'বাছাই মুছুন',
  'cp.selectAll': 'সব variant বাছাই করুন',
  'cp.selectRow': 'বাছাই করুন',

  'cp.col.regular': 'নিয়মিত দাম (৳)',
  'cp.col.regularShort': 'নিয়মিত',
  'cp.col.avgCost': 'গড় খরচ',
  'cp.col.lastCost': 'শেষ কেনা',
  'cp.col.margin': 'মার্জিন',
  'cp.col.standardCost': 'নির্ধারিত কেনা দাম (৳)',
  'cp.col.weight': 'ওজন (গ্রাম)',
  'cp.col.change': 'পরিবর্তন',
  'cp.col.price': 'দাম (৳)',

  'cp.new.quickFills': 'দ্রুত দাম',
  'cp.new.quickFillsHelp':
    'একটি সাইজ বা রঙের দাম লিখুন, মিলে যাওয়া প্রতিটি variant সেই দাম পাবে। সারিতে লেখা দাম দুটোর উপরে থাকে।',
  'cp.new.bySize': 'সাইজ অনুযায়ী দাম',
  'cp.new.byColour': 'রঙ অনুযায়ী দাম',
  'cp.new.ownPrice': 'নিজস্ব দাম',
  'cp.new.setSelected': 'বাছাই করা variant-গুলোর জন্য বসান',
  'cp.new.apply': 'বসান',
  'cp.new.copyDown': 'এই সারি নিচের সারিগুলোতে কপি করুন',
  'cp.new.pricePositive': 'দাম শূন্যের বেশি, টাকায়, দশমিকের পর সর্বোচ্চ দুই ঘর।',
  'cp.new.regularAbove': 'নিয়মিত দাম বিক্রয়মূল্যের বেশি হবে, নয়তো ফাঁকা রাখুন।',
  'cp.new.costPositive': 'প্রতি পিসের খরচ শূন্যের বেশি, টাকায়, দশমিকের পর সর্বোচ্চ দুই ঘর।',
  'cp.new.weight': 'প্রতি পিসের ওজন (গ্রাম)',
  'cp.new.weightHint': 'কুরিয়ারকে এটি জানানো হয়। ফাঁকা রাখলে তাদের নিজস্ব ওজন ধরা হবে।',
  'cp.new.weightInvalid': 'ওজন পূর্ণ গ্রামে, ১ থেকে ১,০০,০০০।',
  'cp.new.sizeChart': 'সাইজ চার্ট',
  'cp.new.sizeChartFromCategory': 'ক্যাটাগরি থেকে',
  'cp.new.costEach':
    'প্রতিটি variant-এর নিজস্ব খরচ থাকতে পারে। উপরের খরচটি ফাঁকা থাকা সারিগুলো পূরণ করে।',

  'cp.hub.editPrices': 'দাম বদলান',
  'cp.hub.stockValue': 'স্টকের মূল্য',
  'cp.hub.bulkTitle': 'অনেক দাম একসাথে বদলান',
  'cp.hub.bulkHelp':
    'variant বাছাই করুন (সারিতে টিক দিন, বা একটি সাইজ বা রঙ), কী করবেন বলুন, তারপর দেখে নিন। সেভ না করা পর্যন্ত কিছুই সেভ হয় না।',
  'cp.hub.choose': 'বাছাই',
  'cp.hub.chooseSize': 'একটি সাইজের সব রঙ',
  'cp.hub.chooseColour': 'একটি রঙের সব সাইজ',
  'cp.hub.field': 'কোন দাম',
  'cp.hub.field.price': 'বিক্রয়মূল্য',
  'cp.hub.field.compareAt': 'নিয়মিত দাম',
  'cp.hub.rule': 'পরিবর্তন',
  'cp.hub.rule.set': 'এই দাম বসান (৳)',
  'cp.hub.rule.add': 'যোগ করুন (৳)',
  'cp.hub.rule.subtract': 'বাদ দিন (৳)',
  'cp.hub.rule.up': 'বাড়ান (%)',
  'cp.hub.rule.down': 'কমান (%)',
  'cp.hub.amount': 'পরিমাণ',
  'cp.hub.round': 'রাউন্ড করুন',
  'cp.hub.round.none': 'রাউন্ড নয়',
  'cp.hub.preview': 'দেখে নিন',
  'cp.hub.previewCount': 'টি দাম বদলাবে',
  'cp.hub.previewNothing': 'বাছাই করা variant-গুলোর কিছুই বদলাবে না।',
  'cp.hub.problem.notPositive': 'শূন্য বা তার কম হয়ে যাবে',
  'cp.hub.problem.tooLarge': 'অনেক বেশি হয়ে যাবে',
  'cp.hub.problem.regular': 'নিয়মিত দাম বিক্রয়মূল্যের সমান বা কম হয়ে যাবে',
  'cp.hub.amountInvalid': 'পরিমাণ লিখুন: দামের জন্য টাকা, শতাংশের জন্য শতাংশ।',
  'cp.hub.reason': 'কারণ (দামের ইতিহাসে থাকবে)',
  'cp.hub.reasonDefault': 'পণ্যের পাতায় বদলানো',
  'cp.hub.saveCount': 'দাম সেভ করুন',
  'cp.hub.changed': 'বদলানো',
  'cp.hub.marginHelp':
    'মার্জিন এই পাতাতেই হিসাব হয়: বিক্রয়মূল্য আর গড় খরচ (বা শেষ কেনা দাম) থেকে।',

  'cp.buy.title': 'কেনা দাম',
  'cp.buy.help':
    'নির্ধারিত কেনা দাম প্রতিটি variant-এর পরের রসিদে আগে থেকে বসে যায়; রসিদে অন্য দামও লেখা যায়। গড় খরচ বদলায় শুধু স্টক এলে।',
  'cp.buy.fillAll': 'সবার জন্য একই',
  'cp.buy.fill': 'বসান',
  'cp.buy.saved': 'কেনা দাম সেভ হয়েছে।',
  'cp.buy.lastFrom': 'থেকে',
  'cp.buy.never': 'কখনো কেনা হয়নি',
  'cp.buy.spreadsheet': 'কেনা দামের স্প্রেডশিট',

  'cp.variant.edit': 'variant বদলান',
  'cp.variant.editHelp':
    'সাপ্লায়ারের নিজস্ব barcode এই variant-এ ERP-র barcode-এর জায়গা নেয়। আগে প্রিন্ট করা স্টিকারে পুরোনোটিই থাকে।',
  'cp.variant.barcode': 'Barcode',
  'cp.variant.barcodeHint':
    'সাপ্লায়ারের barcode স্ক্যান করুন বা লিখুন। ফাঁকা রাখলে SKU কোড প্রিন্ট হবে।',
  'cp.variant.weightHint': 'ফাঁকা রাখলে পণ্যের ওজন ধরা হবে।',
  'cp.variant.archiveStock': 'এই variant-এর স্টকে এখনও পিস আছে',
  'cp.variant.archiveHeld': 'অর্ডারের জন্য রাখা',
  'cp.variant.archiveHeldRefused':
    'অর্ডার এই variant-এর পিস ধরে রেখেছে। আর্কাইভ করার আগে সেই অর্ডারগুলো পাঠান বা বাতিল করুন।',

  'cp.dup.action': 'কপি করুন',
  'cp.dup.title': 'এই পণ্যের কপি বানান',
  'cp.dup.help':
    'ক্যাটাগরি, বিবরণ, variant আর তাদের দাম, ছবি, ওয়েবসাইটের তথ্য আর সাইজ চার্ট কপি হয়। স্টক, কেনা দাম বা ইতিহাস কপি হয় না। কপিটি খসড়া হিসেবে শুরু হয়।',
  'cp.dup.name': 'কপির নাম',
  'cp.dup.copySuffix': 'কপি',
  'cp.dup.submit': 'কপি করুন',

  'cp.extend.title': 'সাইজ ও রঙ',
  'cp.extend.help':
    'নতুন variant যোগ করতে সাইজ বা রঙে টিক দিন; সব রঙে বিক্রি বন্ধ করতে টিক তুলে দিন (স্টক থেকে যায়, সরানো বা বাদ দেওয়া যায়)।',
  'cp.extend.mainPrice': 'নতুন variant-এর দাম (৳)',
  'cp.extend.mainPriceHint': 'নতুন variant অন্য রঙে একই সাইজের দাম পায়; না থাকলে এই দামটি।',
  'cp.extend.willAdd': 'যোগ হবে',
  'cp.extend.willArchive': 'বিক্রি বন্ধ হবে',
  'cp.extend.willRestore': 'আবার বিক্রি হবে',
  'cp.extend.orphans':
    'এই variant-গুলোর কোনো রঙ নেই, নতুনগুলোর সাথে মিলবে না। আর্কাইভ করবেন? স্টক থেকে যাবে।',
  'cp.extend.archiveOrphans': 'আর্কাইভ করুন',
  'cp.extend.submit': 'সাইজ ও রঙ সেভ করুন',
  'cp.extend.done': 'সেভ হয়েছে।',
  'cp.extend.nothing': 'এখনও কিছু বদলানোর নেই: একটি সাইজ বা রঙে টিক দিন বা তুলে দিন।',
  'cp.extend.pieces': 'পিস স্টকে',

  'cp.photo.colour': 'রঙ',
  'cp.photo.anyColour': 'সব রঙ',

  'cp.history.title': 'দামের ইতিহাস',
  'cp.history.none': 'এখনও দাম বদলানো হয়নি।',
  'cp.history.price': 'দাম',
  'cp.history.regular': 'নিয়মিত দাম',

  'cp.list.photo': 'ছবি',
  'cp.list.website': 'ওয়েবসাইট',
  'cp.list.shown': 'দেখানো',
  'cp.list.hidden': 'লুকানো',
  'cp.list.stock': 'স্টক',
  'cp.list.actions': 'কাজ:',
  'cp.list.edit': 'খুলুন',
  'cp.list.show': 'ওয়েবসাইটে দেখান',
  'cp.list.hide': 'ওয়েবসাইট থেকে লুকান',
  'cp.list.archive': 'আর্কাইভ করুন',
  'cp.list.restore': 'ফিরিয়ে আনুন',
  'cp.list.moveTo': 'ক্যাটাগরিতে সরান',
  'cp.list.setChart': 'সাইজ চার্ট বসান',
  'cp.list.noChart': 'সাইজ চার্ট নেই',
  'cp.list.stickers': 'স্টিকার প্রিন্ট করুন',
  'cp.list.done': 'হয়েছে।',
  'cp.list.selectPage': 'এই পাতার সব পণ্য বাছাই করুন',

  'cp.receive.sameForAll': 'সবার জন্য একই খরচ (৳)',
  'cp.receive.sameForAllHint': 'নিজস্ব খরচ নেই এমন প্রতিটি variant পূরণ করে।',
  'cp.receive.prefilled': 'নির্ধারিত বা শেষ কেনা দাম থেকে বসানো হয়েছে; যেকোনোটি বদলাতে পারেন।',
  'cp.receive.source.supplier-standard': 'এই সাপ্লায়ারের নির্ধারিত',
  'cp.receive.source.standard': 'নির্ধারিত',
  'cp.receive.source.last': 'শেষ কেনা',
  'cp.receive.archivedScan': 'এই variant আর্কাইভ করা। রিসিভ করতে পণ্যের পাতায় সেটি ফিরিয়ে আনুন।',
  'cp.receive.costMissing': 'পিস থাকা প্রতিটি variant-এর খরচ লাগবে।',
  'cp.entries.addProduct': 'একটি পণ্য যোগ করুন',
  'cp.entries.addProductHint':
    'পণ্যের নামের তিনটি অক্ষর লিখুন; প্রতিটি চালু variant একটি করে লাইন হবে।',
  'cp.entries.addAll': 'variant-গুলো যোগ করুন',
  'cp.entries.cancelPricing': 'বাতিল',
  'cp.entries.fillBlank': 'ফাঁকাগুলো পূরণ করুন',

  'cp.costs.title': 'কেনা দাম',
  'cp.costs.help':
    'প্রতিটি variant-এর নির্ধারিত কেনা দাম, যেকোনো সাপ্লায়ার বা নির্দিষ্ট একজনের জন্য। এগুলো পরের রসিদে বসে যায়; হিসাবে ঢোকে রসিদের নিজের খরচ।',
  'cp.costs.export': 'স্প্রেডশিট ডাউনলোড করুন',
  'cp.costs.exportHelp':
    'প্রতি variant-এর (আর নিজস্ব দামের প্রতিটি সাপ্লায়ারের) একটি সারি। standard_cost_taka পূরণ করুন, যেটি রাখতে চান সেটি ফাঁকা রাখুন, তারপর আপলোড করুন।',
  'cp.costs.import': 'স্প্রেডশিট আপলোড করুন',
  'cp.costs.check': 'ফাইল যাচাই করুন',
  'cp.costs.commit': 'ইমপোর্ট করুন',
  'cp.costs.willSet': 'টি কেনা দাম বসবে',
  'cp.costs.skipped': 'টি সারি ফাঁকা',
  'cp.costs.problems': 'আগে যে সমস্যাগুলো ঠিক করতে হবে',
  'cp.costs.line': 'লাইন',
  'cp.costs.imported': 'ইমপোর্ট হয়েছে।',
  'cp.costs.chooseFile': 'একটি CSV ফাইল বেছে নিন',
};

export { bn };
