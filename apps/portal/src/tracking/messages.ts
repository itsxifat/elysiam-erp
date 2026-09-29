import type { Locale } from '@elysium/i18n';

/**
 * The public tracking page's strings (M15).
 *
 * **Bangla first.** The page is customer-facing, and D-036 makes everything a customer reads
 * Bangla by default; English is a toggle. Module-local for this wave — the integrator folds
 * `trackingBn` and `trackingEn` into `packages/i18n` — with the English side typed against
 * the Bangla one, so a key on one side only does not compile.
 *
 * One sentence matters more than the rest: `notFound`. It is the page's only negative
 * answer, shown alike for a wrong number, wrong digits, an unknown brand and an order not yet
 * with a courier, because the server answers all of them with the same bytes. So it says what
 * to check without saying which of those it was.
 */
export const trackingBn = {
  'tracking.title': 'অর্ডার ট্র্যাক করুন',
  'tracking.subtitle': 'অর্ডার নম্বর এবং অর্ডারে দেওয়া ফোন নম্বরের শেষ ৪টি সংখ্যা লিখুন।',
  'tracking.orderNo': 'অর্ডার নম্বর',
  'tracking.orderNoHint': 'যেমন OUR-2609-00042 — কনফার্মেশন SMS-এ পাবেন।',
  'tracking.phoneLast4': 'ফোন নম্বরের শেষ ৪ সংখ্যা',
  'tracking.phoneLast4Hint': 'বাংলা বা ইংরেজি, যেকোনো সংখ্যায় লিখতে পারেন।',
  'tracking.submit': 'ট্র্যাক করুন',
  'tracking.checking': 'খোঁজা হচ্ছে…',
  'tracking.notFound':
    'এই তথ্যে কোনো অর্ডার পাওয়া যায়নি। অর্ডার নম্বর ও ফোনের শেষ ৪ সংখ্যা মিলিয়ে দেখুন। নতুন অর্ডার কুরিয়ারে দেওয়ার পর থেকে ট্র্যাক করা যায়।',
  'tracking.rateLimited': 'অনেকবার চেষ্টা করা হয়েছে। কয়েক মিনিট পরে আবার চেষ্টা করুন।',
  'tracking.networkError': 'সার্ভারে পৌঁছানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
  'tracking.invalid': 'অর্ডার নম্বর এবং ফোনের শেষ ৪টি সংখ্যা লিখুন।',
  'tracking.noBrand': 'যে ব্র্যান্ড থেকে কিনেছেন, তাদের পেজে দেওয়া ট্র্যাকিং লিংকটি খুলুন।',
  'tracking.resultHeading': 'অর্ডার',
  'tracking.stage.received': 'অর্ডার পাওয়া গেছে',
  'tracking.stage.processing': 'প্রস্তুত হচ্ছে',
  'tracking.stage.with_courier': 'কুরিয়ারের কাছে',
  'tracking.stage.out_for_delivery': 'ডেলিভারির জন্য বের হয়েছে',
  'tracking.stage.delivered': 'ডেলিভারি হয়েছে',
  'tracking.stage.returned': 'ফেরত পাঠানো হয়েছে',
  'tracking.stage.cancelled': 'বাতিল হয়েছে',
  'tracking.courier': 'কুরিয়ার',
  'tracking.trackingCode': 'কুরিয়ারের ট্র্যাকিং কোড',
  'tracking.cod': 'ডেলিভারির সময় পরিশোধ',
  'tracking.lastUpdate': 'সর্বশেষ আপডেট',
  'tracking.again': 'অন্য অর্ডার খুঁজুন',
  'tracking.language': 'English',
  'tracking.languageLabel': 'ভাষা বদলান',
  'tracking.themeLight': 'লাইট থিম',
  'tracking.themeDark': 'ডার্ক থিম',
} as const;

export type TrackingMessageKey = keyof typeof trackingBn;

export const trackingEn: Record<TrackingMessageKey, string> = {
  'tracking.title': 'Track your order',
  'tracking.subtitle': 'Enter your order number and the last 4 digits of the phone on the order.',
  'tracking.orderNo': 'Order number',
  'tracking.orderNoHint': 'For example OUR-2609-00042 — it is in your confirmation SMS.',
  'tracking.phoneLast4': 'Last 4 digits of the phone',
  'tracking.phoneLast4Hint': 'Bangla or English digits are both fine.',
  'tracking.submit': 'Track',
  'tracking.checking': 'Checking…',
  'tracking.notFound':
    'No order matches these details. Check the order number and the last 4 digits of the phone. A new order can be tracked once it is with the courier.',
  'tracking.rateLimited': 'Too many attempts. Try again in a few minutes.',
  'tracking.networkError': 'The server could not be reached. Check your connection and try again.',
  'tracking.invalid': 'Enter the order number and the last 4 digits of the phone.',
  'tracking.noBrand': 'Open the tracking link on the page of the brand you bought from.',
  'tracking.resultHeading': 'Order',
  'tracking.stage.received': 'Order received',
  'tracking.stage.processing': 'Being prepared',
  'tracking.stage.with_courier': 'With the courier',
  'tracking.stage.out_for_delivery': 'Out for delivery',
  'tracking.stage.delivered': 'Delivered',
  'tracking.stage.returned': 'Returned',
  'tracking.stage.cancelled': 'Cancelled',
  'tracking.courier': 'Courier',
  'tracking.trackingCode': 'Courier tracking code',
  'tracking.cod': 'To pay on delivery',
  'tracking.lastUpdate': 'Last update',
  'tracking.again': 'Track another order',
  'tracking.language': 'বাংলা',
  'tracking.languageLabel': 'Change language',
  'tracking.themeLight': 'Light theme',
  'tracking.themeDark': 'Dark theme',
};

export const trackingMessages: Readonly<Record<Locale, Record<TrackingMessageKey, string>>> = {
  bn: trackingBn,
  en: trackingEn,
};

export function trackingText(locale: Locale, key: TrackingMessageKey): string {
  return trackingMessages[locale][key];
}
