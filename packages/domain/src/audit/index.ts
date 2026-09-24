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
/**
 * References already on the path being walked.
 *
 * `redact` recurses, and a row holding a back-reference — which an ORM with
 * relations produces routinely — raised `RangeError: Maximum call stack size
 * exceeded`. That is worse here than in the serializer: the audit write
 * happens *after* the response has been sent, so the visible result is a
 * mutation that silently went unrecorded, which is exactly the outcome §25's
 * append-only log exists to make impossible.
 *
 * Per path, not per walk, so the same nested object under two keys is still
 * redacted under both.
 */
type Seen = Set<object>;

/**
 * Set a key without `__proto__` replacing the prototype.
 *
 * `result[key] = value` for that one key invokes a setter rather than creating
 * a property, so the redacted copy ends up with a caller-supplied prototype —
 * and `isPlainObject` then refuses to look at it, which for a *redactor* means
 * the fields underneath are never examined at all.
 */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function maskPhonesIn(value: unknown, seen: Seen = new Set()): unknown {
  if (typeof value === 'string') return maskPhone(value);
  if (Array.isArray(value)) return value.map((entry) => maskPhonesIn(entry));
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) assign(result, key, maskPhonesIn(entry, seen));
  seen.delete(value);
  return result;
}

/**
 * A Bangladeshi mobile number anywhere in free text (invariant 10).
 *
 * `+8801XXXXXXXXX`, `8801XXXXXXXXX` or `01XXXXXXXXX`, operator digit 3–9. Not
 * inside a longer run of digits, so an order number or a uuid segment that
 * happens to contain eleven digits is left alone.
 *
 * Masking by key name alone missed every phone that arrived as a value: a
 * reason of "customer 01712345689 refused" or a note field was written into
 * the append-only log verbatim. Keys decide where a phone *probably* is; this
 * catches where one actually is.
 */
const PHONE_IN_TEXT = /(?<![0-9])(?:\+?880|0)1[3-9][0-9]{8}(?![0-9])/g;

export function maskPhonesInText(text: string): string {
  return text.replace(PHONE_IN_TEXT, (match) => {
    const prefix = match.startsWith('+') ? '+' : '';
    return `${prefix}${maskPhone(match)}`;
  });
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
export function redact(value: unknown, seen: Seen = new Set()): unknown {
  if (typeof value === 'string') return maskPhonesInText(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const mapped = value.map((entry) => redact(entry, seen));
    seen.delete(value);
    return mapped;
  }
  if (!isPlainObject(value)) return value;

  // Recorded as a back-reference rather than dropped: the audit log is
  // evidence, and "this pointed at its own parent" is a fact about the row.
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (matches(key, REDACTED_FIELD_PATTERNS)) {
      assign(result, key, REDACTED);
      continue;
    }
    if (matches(key, PHONE_PATTERNS)) {
      // Under a phone-named key, mask whatever shape it arrives in. The string
      // case is the common one, but `{ phones: ['017…','018…'] }` and
      // `{ phone: { number: '017…' } }` were both written out verbatim — and
      // the audit log is append-only, so anything that lands there is permanent.
      assign(result, key, maskPhonesIn(entry, seen));
      continue;
    }
    assign(result, key, redact(entry, seen));
  }
  seen.delete(value);
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
