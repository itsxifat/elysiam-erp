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
  'bkash',
  'iban',
  'cvv',
  'cardnumber',
  'card_number',
];

export const REDACTED = '[redacted]';

/** Field names holding a phone number, which is masked rather than removed. */
const PHONE_PATTERNS: readonly string[] = ['phone', 'mobile', 'msisdn'];

function matches(key: string, patterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
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
  if (digits.length < 6) return '*'.repeat(value.length);

  const head = digits.slice(0, 3);
  const tail = digits.slice(-2);
  return `${head}${'*'.repeat(Math.max(0, digits.length - 5))}${tail}`;
}

/** Mask every string inside a value that sits under a phone-named key. */
function maskPhonesIn(value: unknown): unknown {
  if (typeof value === 'string') return maskPhone(value);
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
 * Both sides are redacted first: a naive implementation that diffs raw rows and
 * redacts afterwards leaks through the comparison itself, since a changed
 * password produces two different `[redacted]` values only if you redact first.
 */
export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const left = before === null ? {} : (redact(before) as Record<string, unknown>);
  const right = after === null ? {} : (redact(after) as Record<string, unknown>);

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changed: string[] = [];

  for (const key of keys) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) changed.push(key);
  }

  return changed.sort();
}
