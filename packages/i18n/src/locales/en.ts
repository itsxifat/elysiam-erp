/**
 * The English catalogue, and the key union every call site is checked against.
 *
 * English is the *source* locale: `MessageKey` is `keyof typeof en`, so this
 * file decides which keys exist and every other locale is typed against it.
 * That direction is deliberate. The console defaults to English (D-036), so a
 * key that only exists in Bangla would be an operator staring at nothing,
 * which is worse than a customer receiving an English word.
 *
 * The catalogue is a flat object rather than nested namespaces on purpose: a
 * flat key is greppable, survives a rename, and lets `MessageKey` be a real
 * union the compiler checks call sites against. There is no runtime fallback to
 * the key itself, so a typo is a build error rather than a string that says
 * `auth.sign_in` to a user in production.
 *
 * Two-space indentation on key lines is load-bearing for `t()`'s sibling,
 * `scripts/check-i18n.mjs`: it imports this module rather than parsing it, so
 * formatting is only a readability convention here — but keep the one-key-per-
 * line shape anyway, because a merge conflict in a 300-key object is otherwise
 * unresolvable.
 */

const en = {
  // Sign-in and two-factor (M02a).
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
  'auth.tooMany': 'Too many attempts. Wait a minute and try again.',
  'auth.rejected':
    'The server rejected that request. Reload the page and try again — your sign-in details are probably fine.',

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

  // Org switching (M02a).
  'org.switch': 'Switch organisation',
  'org.switching': 'Switching…',
  'org.current': 'Current organisation',
  'org.none': 'No organisation is active.',
  'org.chooseOne': 'Choose an organisation to continue.',

  // The placeholder shell, replaced by M05.
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

  // Chrome that every screen from M05 onward needs. Added here rather than
  // when each screen lands so that two screens cannot invent two spellings of
  // "Cancel" and two Bangla translations of it.
  'common.retry': 'Try again',
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.search': 'Search',
  'common.actions': 'Actions',
  'common.all': 'All',
  'common.none': 'None',
  'common.empty': 'Nothing to show yet.',

  /*
   * What the user reads when the API returns problem+json.
   *
   * One message per error *class*, not per error code: the code is for the log
   * and the support conversation, and a wall of distinct sentences for forty
   * codes would be forty chances to leak an internal noun. The API's `detail`
   * is shown alongside only when it was written for an operator to read.
   */
  'error.unexpected': 'Something went wrong. Nothing was saved.',
  'error.forbidden': 'You do not have permission to do that.',
  'error.notFound': 'That no longer exists, or was never visible to you.',
  'error.conflict': 'Somebody changed this while you were working. Reload and try again.',
  'error.validation': 'Check the highlighted fields and try again.',
  'error.rateLimited': 'Too many requests. Wait a moment and try again.',
  'error.offline': 'You appear to be offline. Your work is kept until the connection returns.',

  /*
   * Customer-facing document copy (§22).
   *
   * These ship in Bangla (D-036) — the English side exists so a super admin
   * reviewing a rendered invoice can read it, and so the missing-key check has
   * both sides to compare. A document string that only exists in English is a
   * customer-facing regression, which is why they live in the same catalogue
   * as the console's rather than in the PDF template.
   */
  'doc.invoice.title': 'Invoice',
  'doc.invoice.number': 'Invoice no.',
  'doc.invoice.date': 'Date',
  'doc.invoice.billedTo': 'Billed to',
  'doc.invoice.phone': 'Phone',
  'doc.invoice.address': 'Address',
  'doc.invoice.item': 'Item',
  'doc.invoice.quantity': 'Qty',
  'doc.invoice.unitPrice': 'Unit price',
  'doc.invoice.lineTotal': 'Amount',
  'doc.invoice.subtotal': 'Subtotal',
  'doc.invoice.discount': 'Discount',
  'doc.invoice.delivery': 'Delivery charge',
  'doc.invoice.total': 'Total',
  'doc.invoice.paid': 'Paid',
  'doc.invoice.due': 'Due',
  'doc.invoice.paymentCod': 'Cash on delivery',
  'doc.invoice.thanks': 'Thank you for shopping with us.',
  'doc.invoice.contact': 'Questions about this order?',
} as const;

/** Every key that exists. A call site passing anything else does not compile. */
export type MessageKey = keyof typeof en;

export { en };
