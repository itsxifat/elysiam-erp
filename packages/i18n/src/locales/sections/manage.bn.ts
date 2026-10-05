import type { ManageKey } from './manage.en.js';

/**
 * Deleting and archiving (M39a): the Bangla section, typed against the English one, so a key on
 * one side only does not compile. The words staff in Dhaka say in English (SKU, stock) stay in
 * English, as in the rest of the catalogue.
 */
const bn: Record<ManageKey, string> = {
  'mg.close': 'বন্ধ করুন',
  'mg.cancel': 'বাতিল',
  'mg.loading': 'কোথায় ব্যবহার হচ্ছে দেখা হচ্ছে…',
  'mg.failed': 'কাজটি করা যায়নি। কিছুই বদলায়নি; আবার চেষ্টা করুন।',
  'mg.title': 'মুছুন বা আর্কাইভ করুন',
  'mg.titleNamed': '{name} মুছুন বা আর্কাইভ করুন',
  'mg.unused': '{name} কোথাও ব্যবহার হচ্ছে না। মুছলে এটি স্থায়ীভাবে চলে যাবে।',
  'mg.usedBy': '{name} যেখানে ব্যবহার হচ্ছে',
  'mg.cannotDelete': 'এগুলো ব্যবহার করছে বলে এটি মোছা যাবে না।',
  'mg.andMore': 'এবং আরও',
  'mg.deleteForGood': 'স্থায়ীভাবে মুছুন',
  'mg.archived':
    '{name} আর্কাইভ করা আছে: নতুন কাজে দেখা যায় না, যেখানে ব্যবহার হয়েছে সেখানে থেকে যায়।',
  'mg.archivedBadge': 'আর্কাইভ',
  'mg.restore': 'ফিরিয়ে আনুন',
  'mg.showArchived': 'আর্কাইভ করাগুলো দেখান',

  'mg.empty.title': 'খালি করে মুছুন',
  'mg.empty.categoryHelp':
    'এর প্রোডাক্টগুলো অন্য ক্যাটাগরিতে নিন, সাব-ক্যাটাগরিগুলো এক ধাপ উপরে তুলুন এবং মেনুর লিংক নতুন ক্যাটাগরিতে দিন; তারপর এটি মুছে যাবে। আগে ছাপা প্রোডাক্ট কোডে পুরোনো ক্যাটাগরির অক্ষর থেকে যাবে।',
  'mg.empty.chartHelp':
    'এর প্রোডাক্টগুলোকে অন্য সাইজ চার্ট দিন, বা কোনোটিই না; তারপর এটি মুছে যাবে।',
  'mg.empty.target': 'যেখানে নেবেন',
  'mg.empty.noCategory': 'কোনো ক্যাটাগরি নয়',
  'mg.empty.noChart': 'কোনো সাইজ চার্ট নয়',
  'mg.empty.action': 'সরিয়ে মুছুন',

  'mg.archive.title': 'বরং আর্কাইভ করুন',
  'mg.archive.help':
    'নতুন কাজে এটি দেখা যাবে না, তবে যেখানে আগে ব্যবহার হয়েছে সেখানে থেকে যাবে। যেকোনো সময় ফিরিয়ে আনা যায়।',
  'mg.archive.category':
    'অন্য ক্যাটাগরিতে না নেওয়া পর্যন্ত বা ফিরিয়ে না আনা পর্যন্ত এর প্রোডাক্টগুলো ওয়েবসাইটে দেখা যাবে না।',
  'mg.archive.value':
    'নতুন ভ্যারিয়েন্টে এটি দেওয়া যাবে না; যেসব ভ্যারিয়েন্টে আছে সেগুলোতে থেকে যাবে।',
  'mg.archive.variants': 'এর ভ্যারিয়েন্টগুলোও আর্কাইভ করুন ({n}টি)',
  'mg.archive.location': 'কোনো স্টক না থাকলে তবেই লোকেশন বন্ধ করা যায়।',
  'mg.archive.discount':
    'ক্রেতারা আর এটি ব্যবহার করতে পারবেন না। ফিরিয়ে আনলে এটি থামানো অবস্থায় ফিরবে।',
  'mg.archive.flash': 'এটি বন্ধ হয়ে তালিকা থেকে সরে যাবে; যে দামে বিক্রি হয়েছে তার রেকর্ড থাকবে।',
  'mg.archive.action': 'আর্কাইভ করুন',

  'mg.reason.products': 'প্রোডাক্ট',
  'mg.reason.subcategories': 'সাব-ক্যাটাগরি',
  'mg.reason.variants': 'ভ্যারিয়েন্ট',
  'mg.reason.stock_movements': 'স্টক মুভমেন্ট',
  'mg.reason.stock_on_hand': 'যেখানে স্টক আছে',
  'mg.reason.stock_reserved': 'যেখানে অর্ডারের জন্য স্টক ধরে রাখা আছে',
  'mg.reason.stock_documents': 'স্টকের কাগজ (গণনা, ট্রান্সফার, সমন্বয়, হাতে থাকা স্টক)',
  'mg.reason.order_lines': 'অর্ডারের লাইন',
  'mg.reason.orders': 'অর্ডার',
  'mg.reason.pos_lines': 'টিলের বিক্রি ও ফেরত',
  'mg.reason.pos_registers': 'টিল',
  'mg.reason.supply_lines': 'সাপ্লাইয়ের লাইন',
  'mg.reason.supply_entries': 'সাপ্লাই এন্ট্রি ও ফেরত',
  'mg.reason.supplier_payments': 'সাপ্লায়ারকে পেমেন্ট ও অগ্রিম',
  'mg.reason.supplier_notes': 'নোট',
  'mg.reason.courier_returns': 'কুরিয়ার ফেরত',
  'mg.reason.discounts': 'ডিসকাউন্ট',
  'mg.reason.flash_sale_items': 'ফ্ল্যাশ সেল',
  'mg.reason.redemptions': 'যতবার ব্যবহার হয়েছে',
  'mg.reason.flash_claims': 'সেলের দামে অর্ডার',
  'mg.reason.menu_entries': 'ওয়েবসাইটের মেনু',
  'mg.reason.web_locations': 'ওয়েবসাইট এখান থেকে বিক্রি করে',
  'mg.reason.leads': 'লিড',
  'mg.reason.campaigns': 'বিজ্ঞাপন ক্যাম্পেইন',
  'mg.reason.ad_spend': 'বিজ্ঞাপন খরচের এন্ট্রি',
  'mg.reason.messages_sent': 'পাঠানো মেসেজ',
  'mg.reason.system_template': 'সিস্টেম নিজেই পাঠায়',

  'mg.setup.rename': 'নাম বদলান',
  'mg.setup.order': 'ক্রম বদলান',
  'mg.setup.orderTitle': '{name}-এর ক্রম',
  'mg.setup.orderHelp': 'প্রতিটি স্ক্রিন, পিকার ও স্টিকারে এই ক্রমেই দেখাবে।',
  'mg.setup.moveUp': '{name} উপরে নিন',
  'mg.setup.moveDown': '{name} নিচে নিন',
  'mg.setup.saveOrder': 'ক্রম সেভ করুন',
  'mg.setup.manage': 'মুছুন বা আর্কাইভ করুন',
  'mg.setup.manageNamed': '{name} মুছুন বা আর্কাইভ করুন',
  'mg.setup.locationCodeFixed': 'কোড একই থাকবে: স্টকের রেকর্ড, ট্রান্সফার ও গণনায় এটি আছে।',

  'mg.menu.withChildren':
    '{name} মুছলে এর নিচের {n}টি আইটেমও মুছে যাবে। ওয়েবসাইট সঙ্গে সঙ্গে এগুলো দেখানো বন্ধ করবে।',
  'mg.menu.alone': 'ওয়েবসাইট সঙ্গে সঙ্গে {name} দেখানো বন্ধ করবে।',

  'mg.branch.manage': 'শাখা পরিচালনা',
  'mg.branch.title': '{name} পরিচালনা',
  'mg.branch.name': 'শাখার নাম',
  'mg.branch.codeFixed': 'কোড একই থাকবে: আগের প্রতিটি অর্ডার নম্বর ও ক্যাশ অ্যাকাউন্টে এটি আছে।',
  'mg.branch.rename': 'নাম সেভ করুন',
  'mg.branch.deactivate': 'বন্ধ করুন',
  'mg.branch.reactivate': 'আবার চালু করুন',
  'mg.branch.inactive': 'বন্ধ',
  'mg.branch.never': 'শাখা কখনো মোছা হয় না: এর বিক্রি, ক্যাশ ও কর্মীদের ইতিহাস থেকে যায়।',
  'mg.branch.ready': 'এই শাখায় আর কিছু চলছে না, তাই এটি বন্ধ করা যায়।',
  'mg.branch.blocked': 'এগুলো বন্ধ বা সরানো হলে তবেই শাখা বন্ধ করা যাবে:',
  'mg.branch.registers': 'চালু টিল',
  'mg.branch.openShifts': 'খোলা শিফট',
  'mg.branch.walletsWithMoney': 'টাকা থাকা ওয়ালেট',
  'mg.branch.employees': 'কর্মী',
  'mg.branch.stockPlaces': 'যেখানে স্টক আছে',

  'mg.heads.title': 'খরচ ও আয়ের খাত',
  'mg.heads.help':
    'ক্যাশ এন্ট্রি যে খাতে লেখা হয়। নিজের খাত যোগ করুন; নিজের যোগ করা খাতের নাম বদলানো বা আর্কাইভ করা যায়। খাত কখনো মোছা হয় না, তাই হিসাবে প্রতিটি এন্ট্রি থেকে যায়।',
  'mg.heads.name': 'খাতের নাম',
  'mg.heads.kind': 'ধরন',
  'mg.heads.expense': 'খরচ',
  'mg.heads.income': 'আয়',
  'mg.heads.add': 'খাত যোগ করুন',
  'mg.heads.system': 'স্ট্যান্ডার্ড',
  'mg.heads.systemHint': 'স্ট্যান্ডার্ড খাতের নাম বদলায় না এবং এটি সবসময় চালু থাকে।',
  'mg.heads.renameTitle': 'খাতের নাম বদলান',
  'mg.heads.archive': 'আর্কাইভ করুন',
  'mg.heads.restore': 'ফিরিয়ে আনুন',
  'mg.heads.save': 'সেভ করুন',
};

export { bn };
