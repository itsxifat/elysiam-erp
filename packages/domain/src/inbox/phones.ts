import { isNormalizableBdPhone, normalizeBdPhone, type E164Phone } from '../orders/phone.js';

/**
 * Phone numbers a customer typed into a chat (M42, D-739).
 *
 * The customer panel offers each number it finds in the conversation, so an agent saves it in
 * one click instead of retyping it. What counts as a number is exactly what the order desk
 * accepts (`normalizeBdPhone`, D-170): a Bangladeshi mobile, written `01XXXXXXXXX`, `+8801…`,
 * `8801…` or `008801…`, with single spaces, dots or dashes between the digits, in ASCII or
 * Bangla digits. Each is returned once, in E.164, in the order it first appears.
 *
 * Deliberately conservative, because a wrong suggestion is worse than none: a number has to
 * stand alone (no digit, `+` or letter-digit run glued to either end), so an order number, a
 * tracking code or a price that happens to contain `017…` is not offered. A ten-digit run
 * without its leading `0` (`1712345678`) is not offered either; with no country code in front
 * it is as likely to be a bKash transaction id as a phone.
 */

/** `০-৯` and the Arabic-Indic and full-width forms, read as `0-9`. */
const DIGIT_FORMS: readonly string[] = [
  '০১২৩৪৫৬৭৮৯', // Bangla
  '٠١٢٣٤٥٦٧٨٩', // Arabic-Indic
  '０１２３４５６７８９', // full width
];

/** The same text with every digit written in ASCII, one character for one character. */
export function asciiDigitsIn(text: string): string {
  let out = '';
  for (const char of text) {
    let mapped = char;
    for (const forms of DIGIT_FORMS) {
      const index = forms.indexOf(char);
      if (index >= 0) {
        mapped = String(index);
        break;
      }
    }
    if (char === '＋') mapped = '+';
    out += mapped;
  }
  return out;
}

/**
 * One candidate: an optional country prefix (`+880`, `880`, `00880`, then an optional trunk
 * zero), or the trunk zero alone; `1`, an operator digit, and eight more digits, each group
 * allowed one separator before it. The lookarounds keep a candidate from starting or ending
 * inside a longer run of digits.
 */
const CANDIDATE = /(?<![\d+])(?:(?:\+|00)?880[ .-]?0?|0)1[13-9](?:[ .-]?\d){8}(?!\d)/g;

/** At most this many characters of a message are read: a pasted catalogue is not a chat. */
export const PHONE_SCAN_LIMIT = 20_000;

/**
 * Every Bangladeshi mobile number in `text`, normalised to E.164, first appearance first, each
 * once. Never throws: an arbitrary string gives an empty list.
 */
export function extractBdPhones(text: string): E164Phone[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const ascii = asciiDigitsIn(text.slice(0, PHONE_SCAN_LIMIT));
  const found: E164Phone[] = [];
  const seen = new Set<string>();
  for (const match of ascii.matchAll(CANDIDATE)) {
    const candidate = match[0];
    if (!isNormalizableBdPhone(candidate)) continue;
    const phone = normalizeBdPhone(candidate);
    if (seen.has(phone)) continue;
    seen.add(phone);
    found.push(phone);
  }
  return found;
}

/**
 * The numbers across several messages, newest message first (the number a customer gave most
 * recently is the one an agent most likely wants), each once.
 */
export function phonesAcrossMessages(
  texts: readonly (string | null)[],
  extra: readonly string[] = [],
): E164Phone[] {
  const out: E164Phone[] = [];
  const seen = new Set<string>();
  const add = (phone: E164Phone) => {
    if (seen.has(phone)) return;
    seen.add(phone);
    out.push(phone);
  };
  for (const text of texts) {
    if (text === null) continue;
    for (const phone of extractBdPhones(text)) add(phone);
  }
  for (const candidate of extra) {
    if (isNormalizableBdPhone(candidate)) add(normalizeBdPhone(candidate));
  }
  return out;
}

/**
 * A WhatsApp id as a phone, when it is one (D-739): `wa_id` is the sender's number in
 * international form without the `+` (`8801712345678`), though Meta notes the two "may not
 * always match", so it is offered like any number found in the chat and never saved unasked.
 */
export function phoneFromWhatsAppId(waId: string): E164Phone | null {
  if (!/^\d{8,15}$/.test(waId)) return null;
  const candidate = `+${waId}`;
  return isNormalizableBdPhone(candidate) ? normalizeBdPhone(candidate) : null;
}
