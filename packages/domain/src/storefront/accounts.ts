/**
 * A shopper's website account, as rules (M34, D-522, D-523).
 *
 * The account lives in the ERP; the website keeps its own session and asks the ERP, server to
 * server, to register, verify, sign in and so on. These are the parts of that with no I/O:
 * what an email address is, what a password must be, when a one-time code may still be tried,
 * and which past guest orders an account may claim.
 */

/** RFC 5321's limit on a forward path; anything longer is not an address a mail server takes. */
const MAX_EMAIL_LENGTH = 254;

/**
 * An address as stored and compared: trimmed and lower-cased, or null when it is not one.
 *
 * Deliberately loose about the local part (the old site took anything with an `@` and a dot)
 * and strict about what would break a mail header: no spaces, no control characters, no
 * angle brackets or commas, one `@`, a dot in the domain.
 */
export function normaliseEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f<>(),;:"[\]\\]/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return null;
  const domain = email.slice(at + 1);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  return email;
}

/** New passwords: at least this many characters (D-522; the old site's six still sign in). */
export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt reads only the first 72 bytes; a longer password would be silently cut. */
export const MAX_PASSWORD_BYTES = 72;

export type PasswordProblem = 'too_short' | 'too_long';

export function passwordProblem(password: string): PasswordProblem | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return 'too_long';
  return null;
}

/** A bcrypt hash as the old site (bcryptjs) and this module write it: `$2a$`, `$2b$` or `$2y$`. */
export function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(value);
}

/** The new hashes' cost (D-522), the old site's own. */
export const BCRYPT_COST = 12;

// --- one-time codes and links -------------------------------------------------------------------

export const EMAIL_CODE_TTL_SECONDS = 15 * 60;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

export interface StoredCode {
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly consumedAt: Date | null;
}

export type CodeState = 'usable' | 'expired' | 'used' | 'locked';

/**
 * Whether a stored code may be compared at all, before it is.
 *
 * Five wrong tries burn it (the old site's rule): a six-digit code is a million guesses, and
 * five per code — with a new code needing the resend limit — keeps that out of reach.
 */
export function codeState(
  code: StoredCode,
  now: Date,
  maxAttempts = EMAIL_CODE_MAX_ATTEMPTS,
): CodeState {
  if (code.consumedAt !== null) return 'used';
  if (code.attempts >= maxAttempts) return 'locked';
  if (code.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'usable';
}

/** Six digits, as typed: Bangla digits made ASCII, spaces dropped. Null if it cannot be one. */
export function normaliseCode(input: string): string | null {
  const ascii = input
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/\s+/g, '');
  return /^\d{6}$/.test(ascii) ? ascii : null;
}

// --- claiming guest orders (D-523) ---------------------------------------------------------------

export interface GuestOrderContact {
  /** The address the checkout gave, normalised, or null. */
  readonly email: string | null;
  /** E.164. */
  readonly phoneE164: string;
  /** Already on an account. */
  readonly accountId: string | null;
}

export interface ClaimingAccount {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly phoneE164: string | null;
}

/**
 * Whether a past guest order belongs in this account (D-523).
 *
 * Only for an account whose email is verified, only an order no account holds yet, and only
 * by **the same email**: whoever reads that inbox placed the order. Never by phone — an
 * account's phone is typed, not verified, so a phone match would hand a stranger's orders
 * (name, address, items, tracking) to whoever typed that number into a profile (M34 ledger
 * audit W5). An order placed without an email stays with its view link.
 */
export function claimsGuestOrder(account: ClaimingAccount, order: GuestOrderContact): boolean {
  if (!account.emailVerified || order.accountId !== null) return false;
  return order.email !== null && order.email === account.email;
}

// --- saved addresses -----------------------------------------------------------------------------

export const MAX_SAVED_ADDRESSES = 10;
