/**
 * Addresses, as the address signal compares them (architecture §10, M17, D-231).
 *
 * The same door is written down a dozen ways. Two examples of one address:
 *
 *     House# 12, Road-5, Block C, Mirpur-10
 *     h 12 rd 5 blk c mirpur 10
 *
 * Trigram similarity (pg_trgm) copes with typos and word order. It does not cope with
 * `rd` against `road`: "rd" shares almost no trigrams with "road". So the address is
 * normalised first, and the same function runs when the address is stored and when it
 * is looked up, so both sides are spelled the same way.
 *
 * What it does, in order:
 *
 * 1. Unicode NFKC and lower case.
 * 2. Bangla digits to ASCII (D-170's rule for phones, applied to house numbers).
 * 3. Punctuation to spaces, so `House#12`, `House-12` and `House 12` agree.
 * 4. A boundary between letters and digits, so `mirpur10` and `mirpur 10` agree.
 * 5. Common abbreviations and their Bangla words to one English word each.
 * 6. Filler words (`no`, `number`) dropped, whitespace collapsed.
 *
 * What it deliberately does not do is guess. It does not transliterate Bangla place
 * names, and it does not reorder tokens. A wrong guess would make two different doors
 * look the same, and a false match costs a real buyer an advance they did not owe. A
 * missed match costs one more parcel, which the phone signal may still catch.
 */

const BANGLA_ZERO = 0x09e6;

/** One canonical word per spelling. Keys are whole tokens after steps 1–4. */
const SYNONYMS: Readonly<Record<string, string>> = {
  h: 'house',
  hs: 'house',
  hse: 'house',
  house: 'house',
  holding: 'house',
  basa: 'house',
  basha: 'house',
  bari: 'house',
  বাসা: 'house',
  বাড়ি: 'house',
  বাড়ী: 'house',
  r: 'road',
  rd: 'road',
  road: 'road',
  rod: 'road',
  রোড: 'road',
  সড়ক: 'road',
  blk: 'block',
  block: 'block',
  ব্লক: 'block',
  sec: 'sector',
  sect: 'sector',
  sector: 'sector',
  সেক্টর: 'sector',
  ln: 'lane',
  lane: 'lane',
  লেন: 'lane',
  flat: 'flat',
  apt: 'flat',
  apartment: 'flat',
  ফ্ল্যাট: 'flat',
  flr: 'floor',
  floor: 'floor',
  তলা: 'floor',
  ave: 'avenue',
  avenue: 'avenue',
  st: 'street',
  street: 'street',
  vill: 'village',
  village: 'village',
  gram: 'village',
  গ্রাম: 'village',
  po: 'post',
  post: 'post',
  ps: 'thana',
  thana: 'thana',
  থানা: 'thana',
};

/** Words that carry no location. */
const FILLER = new Set(['no', 'number', 'nong', 'নং', 'nambar']);

/** The longest normalised address kept. Longer text adds no signal and costs index size. */
export const MAX_NORMALIZED_ADDRESS = 300;

/**
 * The comparable form of an address, or the empty string when nothing is left.
 *
 * Joins the address line and the area. The district and thana are ids, compared
 * elsewhere, so they are not text here.
 */
export function normalizeAddress(line: string, area?: string | null): string {
  const raw = `${line} ${area ?? ''}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - BANGLA_ZERO))
    // Everything that is not a letter, a combining mark or a digit is a separator.
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    // `mirpur10` → `mirpur 10`, `12a` stays one token only if it is digits then a letter.
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L}{2,})/gu, '$1 $2');

  const tokens: string[] = [];
  for (const token of raw.split(' ')) {
    if (token === '' || FILLER.has(token)) continue;
    tokens.push(SYNONYMS[token] ?? token);
  }
  return tokens.join(' ').slice(0, MAX_NORMALIZED_ADDRESS).trim();
}

/**
 * How similar two normalised addresses must be to count as one door (D-231).
 *
 * pg_trgm's `similarity()` ranges from 0 to 1. Its default `%` cut-off of 0.3 is meant
 * for search, where showing a near miss is cheap. Here a match can cost a buyer an
 * advance, so the bar is higher. 0.6 keeps:
 *
 * - "house 12 road 5 block c mirpur 10" against "house 12 road 5 mirpur 10" (one token
 *   dropped);
 * - a misspelled area ("mirpor").
 *
 * Similarity alone cannot tell a door from its neighbour. "house 12 road 5 …" and
 * "house 14 road 5 …" share almost every trigram, because a house number is a small
 * part of a long string. `addressNumbers` is the second test for that.
 */
export const ADDRESS_SIMILARITY_THRESHOLD = 0.6;

/**
 * The numbers in a normalised address, sorted and de-duplicated: "10 12 5".
 *
 * Two addresses only match if these are identical, as well as similar. Numbers are what
 * tell a house, a road and a sector apart, and an agent who typed the house number
 * wrong has written a different door as far as a rider is concerned.
 *
 * The cost is a missed match when one spelling omits a number the other has, such as
 * "road 5 mirpur 10" against "house 12 road 5 mirpur 10". That is the safe direction:
 * a missed match costs one parcel, while a false one makes a neighbour pay an advance.
 * For a village address with no numbers this is the empty string on both sides, and
 * similarity decides alone.
 */
export function addressNumbers(normalized: string): string {
  const numbers = new Set<string>();
  for (const token of normalized.split(' ')) {
    if (/^\d+$/.test(token)) numbers.add(token.replace(/^0+(?=\d)/, ''));
  }
  return [...numbers].sort().join(' ');
}
