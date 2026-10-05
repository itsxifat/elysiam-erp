import type { StockToolsKey } from './stock-tools.en.js';

/**
 * Stickers, scanning and stock in hand (M38a): the Bangla section, typed against the English
 * one, so a key on one side only does not compile.
 *
 * The words warehouse staff in Dhaka say in English stay in English (SKU, barcode, scan,
 * sticker), as in the rest of the catalogue.
 */
const bn: Record<StockToolsKey, string> = {
  'st.close': 'বন্ধ করুন',
  'st.cancel': 'বাতিল',
  'st.saveFailed': 'সেভ করা যায়নি। কিছুই বদলায়নি; আবার চেষ্টা করুন।',

  'st.col.item': 'পণ্য',
  'st.col.pieces': 'পিস',
  'st.col.costPerPiece': 'প্রতি পিসের খরচ (৳)',
  'st.col.location': 'লোকেশন',
  'st.col.status': 'অবস্থা',
  'st.col.value': 'মূল্য',
  'st.col.when': 'কখন',
  'st.col.actions': 'কাজ',

  'st.scan.label': 'বারকোড scan করুন বা লিখুন',
  'st.scan.hint': 'প্রতিটি scan একটি করে পিস যোগ করে। কোড লিখে Enter চাপলেও হবে।',
  'st.scan.camera': 'ক্যামেরা দিয়ে scan',
  'st.scan.cameraTitle': 'ক্যামেরা দিয়ে scan করুন',
  'st.scan.cameraHelp': 'স্টিকারটি ফ্রেমের ভেতরে ধরুন। পরিষ্কার হলেই পড়া হয়ে যাবে।',
  'st.scan.cameraFailed': 'ক্যামেরা খোলা যায়নি। ক্যামেরার অনুমতি দিন, অথবা কোডটি লিখুন।',
  'st.scan.added': 'যোগ হয়েছে:',
  'st.scan.notThisProduct': 'এই স্টিকারটি অন্য পণ্যের।',
  'st.scan.notHere': 'এই লোকেশনে নেই:',
  'st.scan.notFound': 'এই ব্র্যান্ডের কোনো পণ্যে এই বারকোড নেই।',
  'st.scan.failed': 'বারকোডটি খোঁজা যায়নি। আবার চেষ্টা করুন।',
  'st.scan.opening': 'scan করা পণ্যটি খোলা হচ্ছে…',
  'st.scan.cannotOpen': 'আপনার ভূমিকায় পণ্য খোলার অনুমতি নেই।',

  'st.stickers.title': 'স্টিকার প্রিন্ট',
  'st.stickers.help': 'প্রতি পিসে একটি স্টিকার। কীসে প্রিন্ট করবেন বেছে নিন; দাম না দিলেও চলে।',
  'st.stickers.medium': 'প্রিন্ট করবেন',
  'st.stickers.medium.thermal-38x25': 'থার্মাল রোল, ৩৮ × ২৫ মিমি',
  'st.stickers.medium.thermal-40x30': 'থার্মাল রোল, ৪০ × ৩০ মিমি',
  'st.stickers.medium.thermal-50x25': 'থার্মাল রোল, ৫০ × ২৫ মিমি',
  'st.stickers.medium.a4-3x8': 'A4 শিট, ৩ × ৮ (প্রতি শিটে ২৪টি)',
  'st.stickers.medium.a4-4x10': 'A4 শিট, ৪ × ১০ (প্রতি শিটে ৪০টি)',
  'st.stickers.startAt': 'শুরুর ঘর',
  'st.stickers.startAtHint': 'এই শিটে আগে ব্যবহৃত স্টিকারগুলো বাদ দিন। ঘর ১ থেকে',
  'st.stickers.showPrice': 'স্টিকারে দাম প্রিন্ট করুন',
  'st.stickers.caption': 'প্রতিটি পণ্যের জন্য কয়টি স্টিকার',
  'st.stickers.count': 'স্টিকার',
  'st.stickers.total': 'মোট স্টিকার:',
  'st.stickers.print': 'প্রিন্ট',
  'st.stickers.parts': 'এক হাজারের বেশি স্টিকার কয়েকটি ফাইলে আসে। একটির পর একটি প্রিন্ট করুন।',
  'st.stickers.part': 'অংশ',
  'st.stickers.ready': 'স্টিকার তৈরি। নতুন ট্যাব না খুললে এখান থেকে খুলুন বা ডাউনলোড করুন।',
  'st.stickers.open': 'খুলুন',
  'st.stickers.download': 'ডাউনলোড',
  'st.stickers.failed': 'স্টিকার তৈরি করা যায়নি। আবার চেষ্টা করুন।',
  'st.stickers.sectionTitle': 'বারকোড স্টিকার',
  'st.stickers.sectionHelp':
    'প্রতিটি পিসের জন্য একটি স্টিকার: প্রতিটি ভ্যারিয়েন্ট স্টকে থাকা পিস থেকে শুরু হয়। প্রিন্টের আগে যেকোনো সংখ্যা বদলাতে পারেন।',
  'st.stickers.choose': 'স্টিকার প্রিন্ট',
  'st.stickers.pick': 'স্টিকারের জন্য বাছুন:',
  'st.stickers.pickColumn': 'স্টিকারের জন্য বাছুন',
  'st.stickers.printPicked': 'বাছাই করা সারির স্টিকার প্রিন্ট',
  'st.stickers.clearPicked': 'বাছাই মুছুন',

  'st.barcode.copy': 'বারকোড কপি',
  'st.barcode.copied': 'কপি হয়েছে',
  'st.barcode.print': 'স্টিকার প্রিন্ট:',

  'st.photos.add': 'ছবি যোগ করুন',
  'st.photos.help':
    'একসাথে কয়েকটি বাছতে পারেন। টেনে ক্রম বদলান; প্রথমটি কভার। যেকোনোটি দোকানের মাপে crop করুন।',
  'st.photos.notImage': 'শুধু JPEG, PNG ও WebP ছবি যোগ করা যায়; বাকিগুলো বাদ গেছে।',
  'st.photos.order': 'ছবিগুলো, যে ক্রমে দেখাবে',
  'st.photos.photo': 'ছবি',
  'st.photos.cover': 'কভার',
  'st.photos.moveLeft': 'আগে আনুন: ছবি',
  'st.photos.moveRight': 'পরে নিন: ছবি',
  'st.photos.makeCover': 'কভার করুন: ছবি',
  'st.photos.crop': 'দোকানের মাপে crop: ছবি',
  'st.photos.remove': 'ছবি সরান',
  'st.photos.cropTitle': 'দোকানের মাপে crop করুন',
  'st.photos.cropHelp':
    'যে অংশ দেখাবে তা ফ্রেমে না আসা পর্যন্ত ছবিটি টানুন, বা arrow key ব্যবহার করুন। ফ্রেম ভরাতে zoom করুন।',
  'st.photos.cropFrame': 'ছবির যে অংশ দেখাবে',
  'st.photos.zoom': 'Zoom',
  'st.photos.cropSave': 'এই crop রাখুন',
  'st.photos.cropFailed':
    'এখানে ছবিটি crop করা যায়নি। যেমন আছে তেমন যোগ করুন, বা অন্যটি চেষ্টা করুন।',

  'st.new.gridHelp':
    'দাম খালি রাখলে বিক্রয়মূল্য ধরা হবে। পিস মানে এখন প্রতিটি ভ্যারিয়েন্টের কয়টি আছে; না থাকলে খালি রাখুন।',
  'st.new.stock': 'স্টক',
  'st.new.stockFrom': 'পিসগুলো কোথা থেকে',
  'st.new.inHand': 'আগে থেকেই হাতে আছে (শুরুর স্টক)',
  'st.new.fromSupplier': 'সাপ্লায়ারের কাছ থেকে এসেছে',
  'st.new.inHandHelp':
    'ব্র্যান্ডের হাতে আগে থেকেই থাকা স্টক। প্রতিটি পিস তার খরচে লেখা হয়; এটি ব্র্যান্ডের শুরুর স্টক হিসেবে গণ্য।',
  'st.new.inHandHelpDraft':
    'ব্র্যান্ডের হাতে আগে থেকেই থাকা স্টক। আপনি পিস গুনবেন; পোস্ট করার আগে অ্যাকাউন্টস প্রতিটির খরচ লিখবে।',
  'st.new.inHandMemo': 'নতুন পণ্যের সাথে শুরুর স্টক',
  'st.new.windowClosed': 'এই ব্র্যান্ডের শুরুর স্টক বন্ধ, তাই নতুন পিস সাপ্লায়ার থেকে নেওয়া হবে।',
  'st.new.costHint': 'সব ভ্যারিয়েন্টের জন্য; উপরের টেবিলে খরচ দিলে সেটাই ধরা হবে।',
  'st.new.costMissing': 'পিস আছে এমন প্রতিটি ভ্যারিয়েন্টে শূন্যের বেশি খরচ দিতে হবে।',
  'st.new.website': 'ওয়েবসাইটের বিবরণ',
  'st.new.websiteHint': 'ঐচ্ছিক: ওয়েবসাইটে পণ্যটি কীভাবে দেখাবে।',
  'st.new.creating': 'পণ্য তৈরি হচ্ছে…',
  'st.new.uploading': 'ছবি আপলোড হচ্ছে',
  'st.new.savingWeb': 'ওয়েবসাইটের বিবরণ সেভ হচ্ছে…',
  'st.new.savingStock': 'স্টক লেখা হচ্ছে…',
  'st.new.doneTitle': 'পণ্য তৈরি হয়েছে',
  'st.new.done': 'পণ্য, এর সাইজ ও রং, ছবি এবং স্টক সেভ হয়েছে।',
  'st.new.donePieces': 'লেখা পিস:',
  'st.new.doneNoStock': 'কোনো স্টক লেখা হয়নি। প্রতি ভ্যারিয়েন্টে একটি স্টিকার দিয়ে শুরু।',
  'st.new.printStickers': 'স্টিকার প্রিন্ট',
  'st.new.another': 'আরেকটি পণ্য যোগ করুন',

  'st.receive.inHandHelp':
    'ব্র্যান্ডের হাতে আগে থেকেই থাকা স্টক, প্রতিটি পিসের খরচসহ। এটি শুরুর স্টক হিসেবে গণ্য।',
  'st.receive.inHandHelpDraft':
    'ব্র্যান্ডের হাতে আগে থেকেই থাকা স্টক। পিস গুনুন; অ্যাকাউন্টস খরচ লিখে পোস্ট করবে।',

  'st.count.scanLabel': 'তাকের প্রতিটি পিস scan করুন',
  'st.count.note': 'কেন গণনা হাতে লেখা হলো',
  'st.count.noteHint': 'গোনা সংখ্যার উপর হাতে লিখলে কারণ দিতে হয়, যা গণনার সাথে রাখা হয়।',

  'st.inHand.tab': 'হাতে থাকা স্টক',
  'st.inHand.title': 'হাতে থাকা স্টক',
  'st.inHand.help':
    'এখানে শুরু করার সময় ব্র্যান্ডের হাতে যে স্টক আছে, প্রতিটি পিসের খরচসহ গুনে তোলা।',
  'st.inHand.deniedTitle': 'স্টক আপনার ভূমিকার অংশ নয়',
  'st.inHand.deniedDetail': 'স্টক দেখার দরকার হলে একজন অ্যাডমিনকে বলুন।',
  'st.inHand.newEntry': 'স্টক গুনে তুলুন',
  'st.inHand.newHelp':
    'পিসগুলো কোথায় আছে বাছুন, প্রতিটি scan করুন (বা পণ্য যোগ করে সংখ্যা লিখুন), প্রতি পিসের খরচ দিন, তারপর পোস্ট করুন।',
  'st.inHand.newHelpDraft':
    'পিসগুলো কোথায় আছে বাছুন এবং প্রতিটি scan করুন (বা পণ্য যোগ করে সংখ্যা লিখুন)। অ্যাকাউন্টস খরচ লিখে পোস্ট করবে।',
  'st.inHand.costHint': 'সব লাইনের জন্য; কোনো লাইনে খরচ দিলে সেটাই ধরা হবে।',
  'st.inHand.memo': 'নোট (তাক, কার্টন…)',
  'st.inHand.addProduct': 'পণ্য যোগ করুন',
  'st.inHand.addProductHint': 'নামের তিনটি অক্ষর লিখুন',
  'st.inHand.variants': 'ভ্যারিয়েন্ট',
  'st.inHand.lines': 'এই এন্ট্রির পিস',
  'st.inHand.removeLine': 'সরান',
  'st.inHand.post': 'হাতে থাকা স্টক পোস্ট করুন',
  'st.inHand.saveDraft': 'অ্যাকাউন্টসের জন্য সেভ করুন',
  'st.inHand.piecesTotal': 'পিস',
  'st.inHand.entries': 'এন্ট্রি',
  'st.inHand.none': 'এখনো কোনো হাতে থাকা স্টক লেখা হয়নি।',
  'st.inHand.draft': 'খরচের অপেক্ষায়',
  'st.inHand.posted': 'পোস্ট হয়েছে',
  'st.inHand.priceAndPost': 'খরচ লিখে পোস্ট',
  'st.inHand.printEntry': 'এই এন্ট্রির স্টিকার প্রিন্ট',
  'st.inHand.deleteDraft': 'ড্রাফট মুছুন',
  'st.inHand.deleteDraftHelp': 'গোনা সংখ্যাগুলো বাদ যাবে। কিছুই পোস্ট হয়নি।',
  'st.inHand.priceTitle': 'প্রতি পিসের খরচ লিখুন',
  'st.inHand.priceHelp': 'প্রতিটি লাইনে টাকায় শূন্যের বেশি খরচ দিতে হবে।',
  'st.window.title': 'শুরুর স্টক',
  'st.window.open': 'খোলা',
  'st.window.closed': 'বন্ধ',
  'st.window.openHelp':
    'ব্র্যান্ডের হাতে থাকা স্টক গুনে তোলা যায়। সব তোলা হলে এটি বন্ধ করুন: তারপর স্টক আসবে শুধু সাপ্লায়ার, ট্রান্সফার, রিটার্ন ও অনুমোদিত সমন্বয় থেকে।',
  'st.window.closedHelp':
    'সব গুনে তোলা হয়েছে। এখন স্টক আসে শুধু সাপ্লায়ার, ট্রান্সফার, রিটার্ন ও অনুমোদিত সমন্বয় থেকে।',
  'st.window.closedOn': 'বন্ধ হয়েছে',
  'st.window.close': 'শুরুর স্টক বন্ধ করুন',
  'st.window.closeTitle': 'শুরুর স্টক বন্ধ করবেন?',
  'st.window.closeHelp':
    'এখন থেকে স্টক আসবে শুধু সাপ্লায়ার, ট্রান্সফার, রিটার্ন বা অনুমোদিত সমন্বয় থেকে। আবার খুলতে দ্বিতীয় একজন অ্যাডমিনের অনুমোদন লাগবে।',
  'st.window.askReopen': 'আবার খোলার অনুরোধ',
  'st.window.reopenTitle': 'শুরুর স্টক আবার খোলার অনুরোধ',
  'st.window.reopenHelp':
    'দ্বিতীয় একজন অ্যাডমিন সিদ্ধান্ত নেবেন। কী পাওয়া গেছে লিখুন, যাতে তিনি বুঝতে পারেন এটি শুরুর স্টক কিনা।',
  'st.window.reason': 'কেন আবার খোলা দরকার',
  'st.window.reopenPending': 'আবার খোলার একটি অনুরোধ দ্বিতীয় অ্যাডমিনের অপেক্ষায় আছে।',
};

export { bn };
