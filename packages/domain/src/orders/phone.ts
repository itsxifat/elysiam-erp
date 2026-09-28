import { maskPhone } from '../audit/index.js';
import { OrderError } from './state.js';

/**
 * Bangladeshi mobile numbers, normalised to E.164 (architecture §9 "Customers").
 *
 * A customer is keyed by their phone number, so this function decides identity: two
 * spellings of the same number that normalise differently become two buyers, with two
 * order histories, two fraud records and a delivery ratio computed from half the
 * evidence. That is the failure this file exists to prevent, and it is why the
 * accepted input set is as wide as §9 asks — `+8801…`, `8801…`, `01…`, spaces,
 * dashes, brackets, and Bangla digits `০-৯` — while the output is always exactly
 * `+8801XXXXXXXXX`.
 *
 * ## Why this is not libphonenumber-js
 *
 * §9 named that library, and it is the right default when a system takes numbers from
 * anywhere. This one does not: every customer, courier and SMS gateway here is
 * Bangladeshi (D-028 makes the currency BDT only), and every courier API in §9's list
 * wants the same eleven-digit mobile. The rule is therefore small enough to state
 * completely — `01`, an operator digit, then eight more digits — and stating it
 * completely buys two things a general library does not give:
 *
 * * it **refuses a landline**. `02-9611000` is a valid Bangladeshi number and a
 *   useless one for a COD order: no SMS, and no courier will accept it as a contact.
 *   libphonenumber would normalise it happily and the failure would surface as a
 *   parcel nobody could call about.
 * * `@elysium/domain` stays a package with **no runtime dependencies** (invariant 11:
 *   pure, tested functions). A 150 kB metadata bundle for one country's mobile
 *   prefixes is a dependency the console ships to every browser.
 *
 * Recorded as D-170. If a later milestone needs international numbers — an overseas
 * reseller, a supplier abroad — that is the point to add the library, for those
 * fields, rather than to widen this one.
 */

/** `০১৭…` to `017…`, so a number typed on a Bangla keyboard is the same number. */
const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

function asciiDigits(input: string): string {
  let result = '';
  for (const char of input) {
    const index = BANGLA_DIGITS.indexOf(char);
    result += index >= 0 ? String(index) : char;
  }
  return result;
}

/**
 * The operator digits BTRC has actually assigned: Grameenphone 7, Robi 8, Banglalink
 * 9, Airtel 6, Teletalk 5, Citycell 1 (legacy), plus 3 and 4 which are allocated but
 * unissued. Listed rather than accepted wholesale so `010…` and `012…` — which are
 * not numbers anyone has — are rejected at the desk instead of at the courier.
 */
const OPERATOR_DIGITS = '13456789';

const NATIONAL = new RegExp(`^01[${OPERATOR_DIGITS}]\\d{8}$`);

/** The canonical form: `+8801` followed by nine digits. */
export type E164Phone = string & { readonly __e164: true };

export function isE164Phone(value: string): value is E164Phone {
  return /^\+8801[13456789]\d{8}$/.test(value);
}

/**
 * Normalise, or refuse.
 *
 * The steps are deliberately in this order: strip decoration first so `+৮৮০ ১৭…` and
 * `+880-17…` reach the prefix test as the same string, then remove exactly one country
 * prefix, then test the eleven national digits **as a whole**. Testing the pieces
 * separately is what accepts `01812` — a valid prefix and a plausible tail that is four
 * digits short — and what turns one customer into several.
 *
 * `+880 01712345678`, with both the country code and the trunk zero, is accepted. It is
 * strictly speaking malformed, and it is also how a great many people write their own
 * number; the digits after the country code are unambiguous, so refusing it would turn
 * a typing habit into a support ticket and, worse, into a second customer record when
 * the same person later types it the other way.
 */
export function normalizeBdPhone(input: string): E164Phone {
  if (typeof input !== 'string') {
    throw new OrderError('ORDER_PHONE_INVALID', 'A phone number is required.');
  }

  // Everything a person might type between the digits, and nothing else. A letter
  // surviving this is a typo worth refusing rather than silently deleting: `0171o2…`
  // deleted down to ten digits would become a *different* valid-looking number.
  const cleaned = asciiDigits(input).replace(/[\s()\-.‐-―]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) {
    throw new OrderError(
      'ORDER_PHONE_INVALID',
      'A phone number may contain only digits, spaces, dashes and brackets.',
    );
  }

  let national = cleaned;
  if (national.startsWith('+880')) national = national.slice(4);
  else if (national.startsWith('880')) national = national.slice(3);
  else if (national.startsWith('00880')) national = national.slice(5);

  // `+8801712345678` leaves `1712345678`: ten digits with the leading zero dropped,
  // which is how an international form is written. Put it back before testing, so
  // both spellings meet the same rule.
  if (/^1[13456789]\d{8}$/.test(national)) national = `0${national}`;

  if (!NATIONAL.test(national)) {
    throw new OrderError(
      'ORDER_PHONE_INVALID',
      `"${maskPhone(input)}" is not a Bangladeshi mobile number.`,
    );
  }

  return `+880${national.slice(1)}` as E164Phone;
}

/** True without throwing, for a validator that wants a boolean. */
export function isNormalizableBdPhone(input: string): boolean {
  try {
    normalizeBdPhone(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * How a Bangladeshi reads their own number back: `01712-345678`.
 *
 * For documents and screens only. Never for a key, a lookup or a courier payload —
 * those take the E.164 form, and the day somebody stores this one is the day the same
 * customer exists twice.
 */
export function formatBdPhoneForDisplay(phone: E164Phone | string): string {
  const e164 = isE164Phone(phone) ? phone : normalizeBdPhone(phone);
  const national = `0${e164.slice(4)}`;
  return `${national.slice(0, 5)}-${national.slice(5)}`;
}
