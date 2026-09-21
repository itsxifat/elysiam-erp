/**
 * @elysium/i18n
 *
 * bn and en messages, plus money, date and number formatters (architecture §4,
 * §24).
 *
 * M02a seeds the catalogue with the strings the login flow needs, because the
 * UI rule is that *every* string goes through here and the first screen is no
 * exception. M03 adds formatMoney; M04 adds the extraction tooling and the
 * missing-key checker that this file's shape is designed for.
 *
 * The catalogue is a flat object rather than nested namespaces on purpose: a
 * flat key is greppable, survives a rename, and lets `MessageKey` below be a
 * real union that the compiler checks call sites against. There is no runtime
 * fallback to the key itself, so a typo is a build error rather than a string
 * that says `auth.sign_in` to a user in production.
 */

export const LOCALES = ['en', 'bn'] as const;
export type Locale = (typeof LOCALES)[number];

/** The console is an operator tool and defaults to English (D-036). */
export const DEFAULT_LOCALE: Locale = 'en';

/** Customer-facing output — invoices, SMS, the storefront — defaults to Bangla. */
export const CUSTOMER_LOCALE: Locale = 'bn';

const en = {
  'auth.title': 'Sign in',
  'auth.subtitle': 'Staff operations',
  'auth.email': 'Email',
  'auth.email.placeholder': 'you@example.com',
  'auth.password': 'Password',
  'auth.signIn': 'Sign in',
  'auth.signingIn': 'Signing in…',
  'auth.signOut': 'Sign out',
  'auth.failed': 'That email and password do not match.',
  'auth.unreachable': 'Cannot reach the server. Check your connection and try again.',

  'auth.twoFactor.title': 'Two-step verification',
  'auth.twoFactor.subtitle': 'Enter the 6-digit code from your authenticator app.',
  'auth.twoFactor.code': 'Verification code',
  'auth.twoFactor.verify': 'Verify',
  'auth.twoFactor.verifying': 'Verifying…',
  'auth.twoFactor.invalid': 'That code is not right. Codes expire every 30 seconds.',
  'auth.twoFactor.useRecovery': 'Use a recovery code instead',
  'auth.twoFactor.useApp': 'Use your authenticator app instead',
  'auth.twoFactor.recoveryCode': 'Recovery code',
  'auth.twoFactor.recoveryHint':
    'One of the codes you saved when you set up two-step verification.',
  'auth.twoFactor.recoveryInvalid': 'That recovery code is not valid, or has already been used.',
  'auth.twoFactor.back': 'Back',

  'auth.enrol.title': 'Set up two-step verification',
  'auth.enrol.subtitle':
    'Your role requires a second factor before you can use the console. This takes about a minute.',
  'auth.enrol.step1': 'Add this key to your authenticator app.',
  'auth.enrol.step2': 'Save your recovery codes. They are shown once and cannot be shown again.',
  'auth.enrol.step3': 'Enter the 6-digit code your app shows to confirm.',
  'auth.enrol.secret': 'Setup key',
  'auth.enrol.copy': 'Copy',
  'auth.enrol.copied': 'Copied',
  'auth.enrol.begin': 'Begin setup',
  'auth.enrol.confirm': 'Confirm and continue',
  'auth.enrol.recoveryCodes': 'Recovery codes',
  'auth.enrol.download': 'Download codes',
  'auth.enrol.acknowledge': 'I have saved my recovery codes',
  'auth.enrol.failed': 'Setup could not be completed. Sign in again and retry.',

  'org.switch': 'Switch organisation',
  'org.switching': 'Switching…',
  'org.current': 'Current organisation',
  'org.none': 'No organisation is active.',
  'org.chooseOne': 'Choose an organisation to continue.',

  'workspace.title': 'Elysium Console',
  'workspace.placeholder':
    'M05 replaces this page with the real application shell. Until then it shows what the server says about this request, which is the whole of M02a.',
  'workspace.organisation': 'Organisation',
  'workspace.roles': 'Roles',
  'workspace.branchScope': 'Branch scope',
  'workspace.wholeOrg': 'Whole organisation',
  'workspace.superAdmin': 'Super admin',
  'workspace.yes': 'Yes',
  'workspace.no': 'No',

  'theme.toLight': 'Switch to light theme',
  'theme.toDark': 'Switch to dark theme',

  'common.retry': 'Try again',
  'common.loading': 'Loading…',
} as const;

export type MessageKey = keyof typeof en;

/**
 * Bangla is typed against the English catalogue, so a key added to one and not
 * the other fails to compile rather than falling back silently at runtime.
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
};

export const messages: Record<Locale, Record<MessageKey, string>> = { en, bn };

/** Look a message up. The key type makes a missing one a compile error. */
export function t(key: MessageKey, locale: Locale = DEFAULT_LOCALE): string {
  return messages[locale][key];
}

/**
 * Bangla needs its own font stack and a different `size-adjust` (§24), so the
 * app has to know which script it is rendering, not only which locale.
 */
export function fontClassFor(locale: Locale): string {
  return locale === 'bn' ? 'font-bangla' : 'font-sans';
}
