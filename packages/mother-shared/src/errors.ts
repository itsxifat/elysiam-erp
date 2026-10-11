/**
 * The mother ERP's error codes (D-480).
 *
 * Its own list, not `@elysium/contracts`' one: that package ships inside every brand's
 * bundle, and a brand must carry no word of the mother. A failed request answers RFC 9457
 * problem+json with one of these as `code`, so the console branches on a code rather than
 * on wording. Append-only, like the brand's list.
 */
export const MOTHER_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  /** Every owner holds a second factor; this session has not enrolled one yet (D-487). */
  'TWO_FACTOR_ENROLMENT_REQUIRED',
  /** The account was removed, or never finished its invite. */
  'ACCOUNT_INACTIVE',
  /** A brand with that slug is already registered. */
  'BRAND_SLUG_TAKEN',
  /** The read connection is not for the brand's read-only reporting role (D-481). */
  'BRAND_CONNECTION_REFUSED',
  /** The brand has no owner sign-in key yet, so no link can be made (D-490). */
  'OWNER_LINK_KEY_MISSING',
  /** The brand is switched off in the registry. */
  'BRAND_INACTIVE',
  /** This build cannot read the brand's database version (D-481). */
  'BRAND_VERSION_MISMATCH',
  /** The brand's database could not be reached or read just now. */
  'BRAND_UNREACHABLE',
  /** No one may remove, reset or approve for themselves (D-488, D-489). */
  'SELF_ACTION_REFUSED',
  /** The last active owner cannot be removed (D-489). */
  'LAST_OWNER',
  /** The request was decided already, or by someone who may not decide it (D-488). */
  'RESET_NOT_DECIDABLE',
  /** An account with that email already exists. */
  'EMAIL_TAKEN',
  /** `MOTHER_SECRETS_KEY` is missing or wrong, so a stored secret cannot be opened. */
  'SECRETS_KEY_INVALID',
  /** The password given to confirm an account change is not this person's (M40). */
  'INVALID_PASSWORD',
  /** The two-step code (or recovery code) given is not right (M40). */
  'INVALID_CODE',
  /** A new authenticator was not confirmed in time; start again (M40). */
  'TWO_FACTOR_SETUP_EXPIRED',
] as const;

export type MotherErrorCode = (typeof MOTHER_ERROR_CODES)[number];

export function isMotherErrorCode(value: string): value is MotherErrorCode {
  return (MOTHER_ERROR_CODES as readonly string[]).includes(value);
}
