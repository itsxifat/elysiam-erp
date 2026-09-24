/**
 * Redaction for the audit log (architecture §25, invariant 10).
 *
 * §25 asks for before/after "with sensitive fields redacted". The audit log is
 * the one table that, by design, holds a copy of every other table's rows — so
 * it is also the one place where forgetting to redact multiplies. A password
 * hash in a user row is bad; a password hash in the audit log is bad forever,
 * because the log is append-only and cannot be tidied afterwards.
 */

/**
 * Field names whose values never reach the log.
 *
 * Matched case-insensitively, and by substring rather than equality, because
 * the names that matter here vary more than a fixed list can track:
 * `password`, `passwordHash`, `password_hash`, `newPassword` are all the same
 * secret. A false positive redacts something harmless; a false negative writes
 * a credential into an append-only table.
 */
export const REDACTED_FIELD_PATTERNS: readonly string[] = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'salt',
  'backupcode',
  'backup_code',
  // `otp` rather than only `totp`: `'otp'.includes('totp')` is false, so the
  // plain `otp` field — §6's reseller phone-OTP flow — was passing through
  // untouched into an append-only table. Verified.
  'otp',
  'pin',
  'credential',
  'privatekey',
  'private_key',
  'signature',
  'jwt',
  'bearer',
  'totp',
  'twofactor',
  'two_factor',
  'nid',
  'nationalid',
  'national_id',
  'kyc',
  'accountnumber',
  'account_number',
  // The adjacent spellings a later module reaches for. `accountNumber` and
  // `bkash` were here; `bankAccount`, `routingNumber`, `passport` and `tin`
  // are the same class of identifier and were not, and a pattern that is
  // missing when the module lands is a pattern nobody adds afterwards —
  // the log is append-only.
  'bankaccount',
  'bank_account',
  'routingnumber',
  'routing_number',
  'passport',
  'tin',
  'bkash',
  'iban',
  'cvv',
  'cardnumber',
  'card_number',
];

export const REDACTED = '[redacted]';

/** Field names holding a phone number, which is masked rather than removed. */
const PHONE_PATTERNS: readonly string[] = ['phone', 'mobile', 'msisdn'];

/**
 * Short patterns that must match a whole word rather than a substring.
 *
 * `'shipping'.includes('pin')` is true, so a plain substring rule redacted
 * `shippingAddress` and `shippingMethod`. Over-redaction is not a leak, but an
 * audit trail that has lost the delivery address is not much of an audit trail
 * either — and the same rule ate `mapping` and `spinner`.
 */
const WORD_PATTERNS: readonly string[] = ['pin', 'otp', 'jwt', 'salt', 'nid', 'cvv', 'kyc'];

/** `apiKeyV2` -> ['api','key','v2']; `x-api-key` -> ['x','api','key']. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * Match a field name against the patterns, however it is spelled.
 *
 * Separators are stripped before comparing, because the same secret arrives as
 * `apiKey`, `api_key`, `api-key` or `API KEY` depending on who wrote the caller.
 * Substring matching on the raw name missed every hyphenated form —
 * `'api-key'.includes('apikey')` is false — so `x-api-key` and `private-key`
 * went into an append-only table verbatim.
 *
 * Short patterns go through `wordsOf` instead, so `pin` catches `pinCode` and
 * `user_pin` without also catching `shippingAddress`.
 */
function matches(key: string, patterns: readonly string[]): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s.]/g, '');
  const words = wordsOf(key);

  return patterns.some((pattern) => {
    if (WORD_PATTERNS.includes(pattern)) {
      return words.some((word) => word === pattern || word.startsWith(pattern));
    }
    return normalised.includes(pattern.replace(/[-_]/g, ''));
  });
}

/**
 * `017******89` (invariant 10).
 *
 * Masked rather than redacted because a phone number is the operational key
 * for a COD order — an audit trail that cannot tell you which customer an
 * action was about is not much of an audit trail — while the middle digits are
 * what make it personal data. Keeps the last two so two numbers on the same
 * prefix stay distinguishable.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  // Too short to mask usefully, and returning it unchanged would hand back a
  // PIN-shaped value that happened to sit under a phone-named key.
  if (digits.length < 6) return '*'.repeat(Math.max(value.length, 1));

  const head = digits.slice(0, 3);
  const tail = digits.slice(-2);
  return `${head}${'*'.repeat(Math.max(0, digits.length - 5))}${tail}`;
}

/**
 * Mask every phone-shaped value under a phone-named key, whatever its type.
 *
 * Numbers included: `{ phone: 1712345689 }` is an ordinary thing for a JSON
 * client to send, and it used to fall past the string check and land in an
 * append-only table unmasked.
 */
function maskPhonesIn(value: unknown): unknown {
  if (typeof value === 'string') return maskPhone(value);
  if (typeof value === 'number' || typeof value === 'bigint') return maskPhone(String(value));
  if (Array.isArray(value)) return value.map((entry) => maskPhonesIn(entry));
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = maskPhonesIn(entry);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Redact a row on its way into the log.
 *
 * Recurses, because a credential nested two levels down is exactly as exposed
 * as one at the top. Returns a new structure; the caller's row is untouched,
 * since it is usually on its way somewhere else too.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (matches(key, REDACTED_FIELD_PATTERNS)) {
      result[key] = REDACTED;
      continue;
    }
    if (matches(key, PHONE_PATTERNS)) {
      // Under a phone-named key, mask whatever shape it arrives in. The string
      // case is the common one, but `{ phones: ['017…','018…'] }` and
      // `{ phone: { number: '017…' } }` were both written out verbatim — and
      // the audit log is append-only, so anything that lands there is permanent.
      result[key] = maskPhonesIn(entry);
      continue;
    }
    result[key] = redact(entry);
  }
  return result;
}

/**
 * The fields that actually changed, so the log records a diff rather than two
 * copies of a row.
 *
 * **Compares the raw values and returns only field names.** An earlier version
 * redacted both sides first, on the reasoning that diffing raw rows leaks
 * through the comparison — but it returns names, never values, so "the
 * password changed" is the entire disclosure, and that is a thing §25 wants
 * recorded rather than hidden.
 *
 * Redacting first actively lost information. Masking keeps a phone's first
 * three and last two digits, so `01712345689` and `01799999689` are both
 * `017******89`: a customer's delivery number being changed — a standard COD
 * fraud pattern, and one of the things an audit trail exists to catch — came
 * back as "nothing changed". A password rotated to another password of any
 * value did the same.
 *
 * The values themselves still go through `redact` on their way into `before`
 * and `after`. This only decides which names are listed.
 */
export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const left = before ?? {};
  const right = after ?? {};

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changed: string[] = [];

  for (const key of keys) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) changed.push(key);
  }

  return changed.sort();
}
