import type { MessageKey } from './en.js';

/**
 * The Bangla catalogue.
 *
 * Typed as `Record<MessageKey, string>`, which makes both kinds of drift a
 * compile error: a key missing here (the record is incomplete) and a key here
 * that English does not have (excess property on the literal). That is the
 * first line of defence; `scripts/check-i18n.mjs` is the second, because the
 * checker also catches a key referenced from somewhere the compiler does not
 * type — a PDF template, an SMS body, a Puck block.
 *
 * Bangla is what customers actually receive (D-036), so the document strings
 * below are the shipped text and the English ones are the review copy. They are
 * written the way Bangladeshi retail writes them — ERP nouns that ops speech
 * keeps in English (POS, SKU, COD) stay in English rather than being translated
 * into words no storekeeper uses.
 */
const bn: Record<MessageKey, string> = {
  'auth.title': 'সাইন ইন',
  'auth.subtitle': 'স্টাফ অপারেশনস',
  'auth.email': 'ইমেইল',
  'auth.email.placeholder': 'you@example.com',
  'auth.password': 'পাসওয়ার্ড',
  'auth.signIn': 'সাইন ইন',
  'auth.signingIn': 'সাইন ইন হচ্ছে…',
  'auth.signOut': 'সাইন আউট',
  'auth.failed': 'ইমেইল বা পাসওয়ার্ড মিলছে না।',
  'auth.unreachable': 'সার্ভারে পৌঁছানো যাচ্ছে না। সংযোগ দেখে আবার চেষ্টা করুন।',
  'auth.tooMany': 'অনেকবার চেষ্টা হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।',
  'auth.rejected':
    'সার্ভার অনুরোধটি ফিরিয়ে দিয়েছে। পাতা রিলোড করে আবার চেষ্টা করুন — আপনার তথ্য সম্ভবত ঠিকই আছে।',

  'auth.twoFactor.title': 'দুই ধাপের যাচাই',
  'auth.twoFactor.subtitle': 'আপনার অ্যাপে দেখানো ৬ সংখ্যার কোড দিন।',
  'auth.twoFactor.code': 'যাচাই কোড',
  'auth.twoFactor.verify': 'যাচাই করুন',
  'auth.twoFactor.verifying': 'যাচাই হচ্ছে…',
  'auth.twoFactor.invalid': 'কোডটি সঠিক নয়। প্রতি ৩০ সেকেন্ডে কোড বদলায়।',
  'auth.twoFactor.useRecovery': 'রিকভারি কোড ব্যবহার করুন',
  'auth.twoFactor.useApp': 'অথেনটিকেটর অ্যাপ ব্যবহার করুন',
  'auth.twoFactor.recoveryCode': 'রিকভারি কোড',
  'auth.twoFactor.recoveryHint': 'সেটআপের সময় সংরক্ষণ করা কোডগুলোর একটি।',
  'auth.twoFactor.recoveryInvalid': 'রিকভারি কোডটি সঠিক নয়, অথবা আগে ব্যবহার হয়েছে।',
  'auth.twoFactor.back': 'ফিরে যান',

  'auth.enrol.title': 'দুই ধাপের যাচাই চালু করুন',
  'auth.enrol.subtitle': 'আপনার ভূমিকার জন্য দ্বিতীয় ধাপ বাধ্যতামূলক। এতে প্রায় এক মিনিট লাগবে।',
  'auth.enrol.step1': 'এই কী আপনার অথেনটিকেটর অ্যাপে যোগ করুন।',
  'auth.enrol.step2': 'রিকভারি কোডগুলো সংরক্ষণ করুন। এগুলো একবারই দেখানো হয়।',
  'auth.enrol.step3': 'নিশ্চিত করতে অ্যাপের ৬ সংখ্যার কোড দিন।',
  'auth.enrol.secret': 'সেটআপ কী',
  'auth.enrol.copy': 'কপি',
  'auth.enrol.copied': 'কপি হয়েছে',
  'auth.enrol.begin': 'সেটআপ শুরু করুন',
  'auth.enrol.confirm': 'নিশ্চিত করে এগিয়ে যান',
  'auth.enrol.recoveryCodes': 'রিকভারি কোড',
  'auth.enrol.download': 'কোড ডাউনলোড করুন',
  'auth.enrol.acknowledge': 'আমি রিকভারি কোড সংরক্ষণ করেছি',
  'auth.enrol.failed': 'সেটআপ সম্পূর্ণ হয়নি। আবার সাইন ইন করে চেষ্টা করুন।',

  'org.switch': 'প্রতিষ্ঠান পরিবর্তন',
  'org.switching': 'পরিবর্তন হচ্ছে…',
  'org.current': 'বর্তমান প্রতিষ্ঠান',
  'org.none': 'কোনো প্রতিষ্ঠান সক্রিয় নেই।',
  'org.chooseOne': 'এগিয়ে যেতে একটি প্রতিষ্ঠান বেছে নিন।',

  'workspace.title': 'এলিসিয়াম কনসোল',
  'workspace.placeholder':
    'M05 এই পাতার জায়গায় আসল অ্যাপ্লিকেশন শেল আনবে। ততক্ষণ এটি দেখায় সার্ভার এই অনুরোধ সম্পর্কে কী বলছে — যা M02a-এর পুরোটাই।',
  'workspace.organisation': 'প্রতিষ্ঠান',
  'workspace.roles': 'ভূমিকা',
  'workspace.branchScope': 'শাখার পরিধি',
  'workspace.wholeOrg': 'সম্পূর্ণ প্রতিষ্ঠান',
  'workspace.superAdmin': 'সুপার অ্যাডমিন',
  'workspace.yes': 'হ্যাঁ',
  'workspace.no': 'না',

  'theme.toLight': 'লাইট থিমে যান',
  'theme.toDark': 'ডার্ক থিমে যান',

  'common.retry': 'আবার চেষ্টা করুন',
  'common.loading': 'লোড হচ্ছে…',
  'common.save': 'সংরক্ষণ',
  'common.cancel': 'বাতিল',
  'common.close': 'বন্ধ করুন',
  'common.confirm': 'নিশ্চিত করুন',
  'common.back': 'ফিরে যান',
  'common.next': 'পরবর্তী',
  'common.search': 'খুঁজুন',
  'common.actions': 'কাজ',
  'common.all': 'সব',
  'common.none': 'কোনোটি নয়',
  'common.empty': 'এখনো দেখানোর কিছু নেই।',

  'error.unexpected': 'কিছু একটা ভুল হয়েছে। কোনো তথ্য সংরক্ষণ হয়নি।',
  'error.forbidden': 'এই কাজ করার অনুমতি আপনার নেই।',
  'error.notFound': 'এটি আর নেই, অথবা কখনোই আপনার জন্য দৃশ্যমান ছিল না।',
  'error.conflict': 'আপনি কাজ করার সময় অন্য কেউ এটি বদলেছে। রিলোড করে আবার চেষ্টা করুন।',
  'error.validation': 'চিহ্নিত ঘরগুলো দেখে আবার চেষ্টা করুন।',
  'error.rateLimited': 'অনেক বেশি অনুরোধ। একটু পরে আবার চেষ্টা করুন।',
  'error.offline': 'আপনি সম্ভবত অফলাইনে আছেন। সংযোগ ফিরলে কাজটি পাঠানো হবে।',

  'doc.invoice.title': 'চালান',
  'doc.invoice.number': 'চালান নম্বর',
  'doc.invoice.date': 'তারিখ',
  'doc.invoice.billedTo': 'গ্রাহক',
  'doc.invoice.phone': 'ফোন',
  'doc.invoice.address': 'ঠিকানা',
  'doc.invoice.item': 'পণ্য',
  'doc.invoice.quantity': 'পরিমাণ',
  'doc.invoice.unitPrice': 'একক দাম',
  'doc.invoice.lineTotal': 'মোট',
  'doc.invoice.subtotal': 'উপমোট',
  'doc.invoice.discount': 'ছাড়',
  'doc.invoice.delivery': 'ডেলিভারি চার্জ',
  'doc.invoice.total': 'সর্বমোট',
  'doc.invoice.paid': 'পরিশোধিত',
  'doc.invoice.due': 'বাকি',
  'doc.invoice.paymentCod': 'ক্যাশ অন ডেলিভারি',
  'doc.invoice.thanks': 'আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।',
  'doc.invoice.contact': 'এই অর্ডার নিয়ে কোনো প্রশ্ন?',
};

export { bn };
