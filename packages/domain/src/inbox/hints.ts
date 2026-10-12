import { isValidEan13 } from '../barcode/ean13.js';
import { asciiDigitsIn } from './phones.js';

/**
 * What a customer asks for in a chat (M44b, D-770): sizes, body measurements, quantities,
 * colours and the products they point at, read from English, Bangla and Banglish (Bangla in
 * Latin letters) messages, with Bangla digits read as digits.
 *
 * The inbox's side card offers what it finds, so an agent adds "XL, two pieces" to the draft
 * order in one key press instead of retyping it. Like the phone extractor next door, it is
 * conservative: a wrong suggestion costs the agent a dismissal and their trust, a missed one
 * costs only the typing it would have saved. So a bare `L`, `M` or `S` counts only beside a size
 * word ("L size", "size M", "এল সাইজ"), a want word ("M chai") or alone in a short message; a
 * bare number is never a quantity without its classifier ("2 ta", "২টা", "2 pcs"); a
 * measurement needs the body part or a unit that names it (feet for height, kg for weight).
 *
 * Every hint carries the message it came from and its span in that message (UTF-16 offsets
 * into the text as it was written: digits are read through `asciiDigitsIn`, which keeps every
 * offset), so the card can show the words it read. Never throws: an arbitrary string gives a
 * list, possibly empty.
 */

export const MEASUREMENT_PARTS = [
  'chest',
  'waist',
  'hip',
  'length',
  'shoulder',
  'sleeve',
  'height',
  'weight',
] as const;
export type MeasurementPart = (typeof MEASUREMENT_PARTS)[number];

/** The unit a measurement was written in. Lengths are also given in inches, weight in kg. */
export type MeasureUnit = 'in' | 'cm' | 'ft' | 'kg';

export interface HintSpan {
  readonly start: number;
  readonly end: number;
}

interface HintBase {
  /** The message it was read from, or null for a text read on its own. */
  readonly messageId: string | null;
  readonly span: HintSpan;
  /** The words it was read from, exactly as written. */
  readonly source: string;
}

export interface SizeHint extends HintBase {
  readonly kind: 'size';
  /** `XS` to `5XL` (`XXL` for 2XL, `XXXL` for 3XL), `FREE`, or a number such as `40`. */
  readonly size: string;
}

export interface QuantityHint extends HintBase {
  readonly kind: 'quantity';
  readonly qty: number;
}

export interface MeasurementHint extends HintBase {
  readonly kind: 'measurement';
  readonly part: MeasurementPart;
  /** As written: `42` of "chest 42", `5.5` of "5 ft 6" is not this; see `inches`. */
  readonly value: number;
  readonly unit: MeasureUnit;
  /** A length in inches, to one decimal (height included); null for weight. */
  readonly inches: number | null;
  /** A weight in kilograms; null for a length. */
  readonly kg: number | null;
}

export interface ColourHint extends HintBase {
  readonly kind: 'colour';
  /** The catalog's own name for it, as the brand wrote it. */
  readonly colour: string;
}

export type ProductRef =
  | { readonly type: 'code'; readonly code: string }
  | { readonly type: 'barcode'; readonly barcode: string }
  | { readonly type: 'link'; readonly slug: string; readonly url: string };

export interface ProductHint extends HintBase {
  readonly kind: 'product';
  readonly ref: ProductRef;
}

export type ChatHint = SizeHint | QuantityHint | MeasurementHint | ColourHint | ProductHint;

export interface HintOptions {
  /** The catalog's colour names (Settings' colour values), as the brand writes them. */
  readonly colours?: readonly string[];
  /** The brand website's host names (`elysiam.com`); a link elsewhere is not a product. */
  readonly siteHosts?: readonly string[];
}

/** A message is read up to this many characters: a pasted catalogue is not a request. */
export const HINT_SCAN_LIMIT = 4_000;

/** Quantities a chat can mean: one to 99 pieces. */
export const MAX_HINT_QTY = 99;

// --- spelling the patterns -------------------------------------------------------------------

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * য়, ড় and ঢ় are typed both as one code point and as the letter with its nukta (Unicode
 * keeps both, and NFC leaves the pair), so a pattern accepts either.
 */
const NUKTA_FORMS: readonly (readonly [string, string])[] = [
  ['ড়', 'ড়'],
  ['ঢ়', 'ঢ়'],
  ['য়', 'য়'],
];

/** One word or phrase as a pattern: escaped, nukta either way, spaces as any gap. */
function wordPattern(word: string): string {
  let out = word.trim();
  for (const [single, pair] of NUKTA_FORMS) out = out.split(pair).join(single);
  out = escape(out);
  for (const [single, pair] of NUKTA_FORMS) out = out.split(single).join(`(?:${single}|${pair})`);
  return out.replace(/\s+/g, '[\\s-]*');
}

/** Alternatives, longest first, so "extra large" is tried before "large". */
function alternatives(words: readonly string[]): string {
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(wordPattern)
    .join('|');
}

/** Nothing of a word (any script's letter, mark or digit) right before. */
const START = '(?<![\\p{L}\\p{M}\\p{N}])';
/**
 * Bangla endings a word may carry ("এক্সএলটা", "বুকের", "সাইজের"): read through, then nothing
 * of a word may follow.
 */
const BN_ENDING = '(?:টা|টি|টার|টির|টাই|টাও|টে|এর|ের|র|ে|ও|ই)?';
const END = `${BN_ENDING}(?![\\p{L}\\p{M}\\p{N}])`;

// --- sizes -------------------------------------------------------------------------------------

/** Each size and how people write it, other than the bare letters S, M and L. */
const SIZE_WORDS: readonly (readonly [string, readonly string[]])[] = [
  ['XXS', ['xxs', '2xs']],
  ['XS', ['xs', 'এক্সএস', 'এক্স এস', 'এক্সট্রা স্মল']],
  ['S', ['স্মল', 'স্মল']],
  ['M', ['মিডিয়াম', 'মেডিয়াম', 'মিডিয়াম']],
  ['L', ['লার্জ', 'লার্জ']],
  ['XL', ['xl', 'x-l', 'এক্সএল', 'এক্স এল', 'এক্সট্রা লার্জ']],
  ['XXL', ['xxl', '2xl', 'double xl', 'এক্সএক্সএল', 'ডাবল এক্সএল', '2এক্সএল', 'টু এক্সএল']],
  ['XXXL', ['xxxl', '3xl', 'triple xl', 'থ্রি এক্সএল', 'ট্রিপল এক্সএল', '3এক্সএল']],
  ['4XL', ['4xl', 'xxxxl', '4এক্সএল', 'ফোর এক্সএল']],
  ['5XL', ['5xl', 'xxxxxl', '5এক্সএল']],
  ['FREE', ['free size', 'freesize', 'free-size', 'ফ্রি সাইজ', 'ফ্রি সাইজ']],
];

/**
 * English words that are sizes only in context: "medium dien", "large ache?", "size small",
 * a message that ends on one; "a small problem" is not a size.
 */
const SIZE_ADJECTIVES: readonly (readonly [string, readonly string[]])[] = [
  ['XS', ['extra small']],
  ['S', ['small', 'smal']],
  ['M', ['medium', 'midium', 'mediam', 'medum']],
  ['L', ['large', 'larg']],
  ['XL', ['extra large']],
];

/** The bare letters, which count only in company (see the module's note). */
const SINGLE_LETTERS: readonly (readonly [string, readonly string[]])[] = [
  ['S', ['s', 'এস']],
  ['M', ['m', 'এম']],
  ['L', ['l', 'এল']],
];

const SIZE_WORD = ['size', 'saiz', 'sz', 'sizes', 'সাইজ', 'সাইজে', 'সাইজের'];
const WANT_WORD = [
  'chai',
  'cai',
  'lagbe',
  'lagbo',
  'dorkar',
  'den',
  'din',
  'diben',
  'dien',
  'hobe',
  'চাই',
  'লাগবে',
  'দরকার',
  'দিন',
  'দেন',
  'দিবেন',
  'হবে',
];
const NUMBER_SIZE_WORD = [
  'size',
  'saiz',
  'sz',
  'সাইজ',
  'সাইজের',
  'no',
  'number',
  'nombor',
  'nmbr',
  'নাম্বার',
  'নম্বর',
  'নং',
];

const sizeByWord = new Map<string, string>();
for (const [size, words] of [...SIZE_WORDS, ...SIZE_ADJECTIVES, ...SINGLE_LETTERS]) {
  for (const word of words) sizeByWord.set(normaliseWord(word), size);
}

function normaliseWord(word: string): string {
  let out = asciiDigitsIn(word)
    .toLowerCase()
    .replace(/[\s-]+/g, '');
  for (const [single, pair] of NUKTA_FORMS) out = out.split(pair).join(single);
  return out;
}

/**
 * A size label (a chart's "XL", a SKU's "2XL", a customer's "এক্সএল") as one canonical word:
 * `XXL` for 2XL, `FREE` for free size, the number for a numeric size. Null when it is none.
 */
export function canonicalSize(label: string): string | null {
  if (typeof label !== 'string') return null;
  const word = normaliseWord(label.trim());
  if (word === '') return null;
  const named = sizeByWord.get(word);
  if (named !== undefined) return named;
  if (/^\d{2,3}$/.test(word)) return String(Number(word));
  if (/^(xxs|xs|s|m|l|xl|xxl|xxxl|4xl|5xl)$/.test(word)) return word.toUpperCase();
  return null;
}

/** Whether two size labels name the same size ("2XL" and "XXL", "Free Size" and "free"). */
export function sameSize(a: string, b: string): boolean {
  const left = canonicalSize(a);
  return left !== null && left === canonicalSize(b);
}

const SIZE_ANY = alternatives([
  ...SIZE_WORDS.flatMap(([, words]) => words),
  ...SIZE_ADJECTIVES.flatMap(([, words]) => words),
  ...SINGLE_LETTERS.flatMap(([, words]) => words),
]);
/** What makes "medium" a size: what is wanted, asked about or taken next. */
const SIZE_CONTEXT_WORD = [
  ...SIZE_WORD,
  ...WANT_WORD,
  'ache',
  'ase',
  'nibo',
  'nebo',
  'nilam',
  'ta',
  'টা',
  'আছে',
  'নিবো',
  'নেব',
  'নিব',
];
const SIZE_MULTI = alternatives(SIZE_WORDS.flatMap(([, words]) => words));

/** A size word anywhere: XL, 2XL, "extra large", এক্সএল, free size. */
const SIZE_ALONE = new RegExp(`${START}(?<size>${SIZE_MULTI})${END}`, 'giud');
/** "medium" and its kin, before a word that makes it a size or at the end of a sentence. */
const SIZE_ADJECTIVE = new RegExp(
  `${START}(?<size>${alternatives(SIZE_ADJECTIVES.flatMap(([, words]) => words))})(?=\\s*(?:$|[.!?,;)\\n]|(?:${alternatives(SIZE_CONTEXT_WORD)})${END}))`,
  'giud',
);
/** Any size, letters included, after "size": "size M", "সাইজ এল", "size: xl". */
const SIZE_AFTER_WORD = new RegExp(
  `${START}(?:${alternatives(SIZE_WORD)})\\s*[:=\\-–]?\\s*(?<size>${SIZE_ANY})${END}`,
  'giud',
);
/** Any size before "size" or a want word: "L size", "এল সাইজ", "M chai", "এম লাগবে". */
const SIZE_BEFORE_WORD = new RegExp(
  `${START}(?<size>${SIZE_ANY})${BN_ENDING}\\s*(?:${alternatives([...SIZE_WORD, ...WANT_WORD])})${END}`,
  'giud',
);
/** A capital S, M or L standing alone, read only in a short message ("L", "M please"). */
const SIZE_CAPITAL = /(?<![\p{L}\p{M}\p{N}'’.])(?<size>[SML])(?![\p{L}\p{M}\p{N}'’]|\.\s*\p{L})/dgu;
const SHORT_MESSAGE = 40;
/** A numeric size beside its word: "size 40", "৪০ সাইজ", "42 number". */
const SIZE_NUMBER = new RegExp(
  `${START}(?:(?:${alternatives(SIZE_WORD)})\\s*[:=\\-–]?\\s*(?<after>\\d{2})(?![\\d.])|(?<before>\\d{2})\\s*(?:${alternatives(NUMBER_SIZE_WORD)})${END})`,
  'giud',
);
const NUMERIC_SIZE_MIN = 22;
const NUMERIC_SIZE_MAX = 60;

// --- quantities --------------------------------------------------------------------------------

const PIECE_WORD = [
  'pcs',
  'pc',
  'pieces',
  'piece',
  'peace',
  'pis',
  'ta',
  'ti',
  'টা',
  'টি',
  'পিস',
  'খানা',
];
/** Number words that carry their classifier already ("duita", "দুইটা"); two or more. */
const COUNTED_WORDS: readonly (readonly [number, readonly string[]])[] = [
  [2, ['duita', 'duto', 'duta', 'duiti', 'দুইটা', 'দুটো', 'দুটা', 'দুইটি', 'দুটি', 'দুইটে']],
  [3, ['tinta', 'tinti', 'tinte', 'তিনটা', 'তিনটি', 'তিনটে']],
  [4, ['charta', 'charti', 'charte', 'চারটা', 'চারটি', 'চারটে']],
  [5, ['pachta', 'panchta', 'pachti', 'পাঁচটা', 'পাঁচটি', 'পাচটা', 'পাঁচটে']],
  [6, ['choyta', 'choita', 'ছয়টা', 'ছয়টি']],
  [7, ['satta', 'সাতটা', 'সাতটি']],
  [8, ['atta', 'আটটা', 'আটটি']],
  [9, ['noyta', 'নয়টা', 'নয়টি']],
  [10, ['doshta', 'দশটা', 'দশটি']],
];
/** Bare number words, counted only before a piece word ("two pieces", "dui ta", "এক পিস"). */
const NUMBER_WORDS: readonly (readonly [number, readonly string[]])[] = [
  [1, ['one', 'ek', 'ekta', 'এক', 'একটা', 'একটি']],
  [2, ['two', 'dui', 'du', 'দুই', 'দু']],
  [3, ['three', 'tin', 'তিন']],
  [4, ['four', 'char', 'চার']],
  [5, ['five', 'pach', 'panch', 'পাঁচ', 'পাচ']],
  [6, ['six', 'choy', 'ছয়']],
  [7, ['seven', 'sat', 'সাত']],
  [8, ['eight', 'at', 'আট']],
  [9, ['nine', 'noy', 'নয়']],
  [10, ['ten', 'dosh', 'দশ']],
];
/** The piece words that make a "one" explicit: "1 pcs", "ekta piece", "এক পিস". */
const STRICT_PIECE_WORD = ['pcs', 'pc', 'pieces', 'piece', 'peace', 'pis', 'পিস'];

const countByWord = new Map<string, number>();
for (const [count, words] of [...COUNTED_WORDS, ...NUMBER_WORDS]) {
  for (const word of words) countByWord.set(normaliseWord(word), count);
}

/** Digits and a classifier: "2 ta", "২টা", "2pcs", "3 piece". */
const QTY_DIGITS = new RegExp(
  `(?<![\\d.])(?<n>\\d{1,2})\\s*(?<piece>${alternatives(PIECE_WORD)})${END}`,
  'giud',
);
/** "qty 2", "quantity: 3", "পরিমাণ ২". */
const QTY_LABELLED = new RegExp(
  `${START}(?:qty|qnty|quantity|পরিমাণ|পরিমান)\\s*[:=\\-–]?\\s*(?<n>\\d{1,2})(?![\\d.])`,
  'giud',
);
/** "duita", "দুটো": the count and its classifier in one word. */
const QTY_COUNTED = new RegExp(
  `${START}(?<word>${alternatives(COUNTED_WORDS.flatMap(([, words]) => words))})${END}`,
  'giud',
);
/** "two pieces", "dui ta", "এক পিস". */
const QTY_WORDED = new RegExp(
  `${START}(?<word>${alternatives(NUMBER_WORDS.flatMap(([, words]) => words))})\\s*(?<piece>${alternatives(PIECE_WORD)})${END}`,
  'giud',
);
/** A count right before a size: "2 XL", "৩ এক্সএল" (but "2XL", written together, is XXL). */
const QTY_BEFORE_SIZE = new RegExp(
  `(?<![\\d.\\p{L}])(?<n>[1-9])\\s+(?=(?:${SIZE_MULTI})${END})`,
  'giud',
);
const QTY_BEFORE_CAPITAL = /(?<![\d.\p{L}])(?<n>[1-9])\s+(?=[SML](?![\p{L}\p{M}\p{N}]))/dgu;

// --- measurements ------------------------------------------------------------------------------

const PART_WORDS: readonly (readonly [MeasurementPart, readonly string[]])[] = [
  [
    'chest',
    ['chest', 'chast', 'bust', 'buk', 'buker', 'bukh', 'chati', 'chhati', 'বুক', 'ছাতি', 'চেস্ট'],
  ],
  ['waist', ['waist', 'waste', 'komor', 'komar', 'kombor', 'কোমর', 'ওয়েস্ট']],
  ['hip', ['hip', 'hips', 'হিপ']],
  ['length', ['length', 'lenth', 'lengh', 'long', 'jhul', 'ঝুল', 'লং', 'দৈর্ঘ্য', 'body length']],
  ['shoulder', ['shoulder', 'sholder', 'soulder', 'kadh', 'kandh', 'কাঁধ', 'কাধ', 'শোল্ডার']],
  ['sleeve', ['sleeve', 'sleve', 'hata', 'হাতা']],
  ['height', ['height', 'hight', 'heigth', 'uchchota', 'ucchota', 'উচ্চতা', 'হাইট']],
  ['weight', ['weight', 'weigth', 'wazon', 'ojon', 'ozon', 'ওজন', 'ওয়েট', 'ওয়েইট']],
];
/** "lomba"/"লম্বা" is tall or long: a height in feet, else a garment's length. */
const TALL_WORDS = ['lomba', 'lamba', 'লম্বা', 'লম্বায়'];

const partByWord = new Map<string, MeasurementPart | 'tall'>();
for (const [part, words] of PART_WORDS) {
  for (const word of words) partByWord.set(normaliseWord(word), part);
}
for (const word of TALL_WORDS) partByWord.set(normaliseWord(word), 'tall');

const PART_ANY = alternatives([...PART_WORDS.flatMap(([, words]) => words), ...TALL_WORDS]);
const FILLER = alternatives([
  'er',
  'is',
  'ta',
  'holo',
  'hobe',
  'mapa',
  'map',
  'maap',
  'size',
  'সাইজ',
  'মাপ',
  'হলো',
  'হল',
  'হবে',
  'আমার',
  'আছে',
]);
const UNIT_INCH = ['inches', 'inch', 'inchi', 'ins', 'in', 'ইঞ্চি', '"', '”', "''"];
const UNIT_CM = ['centimeter', 'centimetre', 'cm', 'সেমি', 'সে.মি.', 'সেন্টিমিটার'];
const UNIT_KG = ['kgs', 'kg', 'kilo', 'kilogram', 'কেজি', 'কেজি.'];
const UNIT_FT = ['feet', 'foot', 'ft', 'fit', "'", '’', 'ফুট', 'ফিট'];
const UNIT_END = '(?![\\p{L}\\p{M}])';

const VALUE = '\\d{1,3}(?:\\.\\d{1,2})?';
const UNIT_OTHER = alternatives([...UNIT_INCH, ...UNIT_CM, ...UNIT_KG]);
/**
 * The value and its unit; a second number only after feet ("5 ft 6"), so "chest 42 inch 2 ta"
 * keeps its chest and leaves the "2 ta" to the quantities.
 */
/** A number of days, hours or taka is not a measurement: "long 15 days", "chest 42 taka". */
const NOT_A_MEASURE = `(?!\\s*(?:${alternatives([
  'days',
  'day',
  'din',
  'দিন',
  'hours',
  'hour',
  'ghonta',
  'ঘণ্টা',
  'ঘন্টা',
  'minutes',
  'minute',
  'mins',
  'min',
  'মিনিট',
  'taka',
  'tk',
  'টাকা',
  '৳',
  '%',
])})(?![\\p{L}\\p{M}]))`;
const MEASURE_TAIL = `(?<v>${VALUE})(?!\\d)(?!\\.\\d)${NOT_A_MEASURE}(?:\\s*(?:(?<ft>${alternatives(UNIT_FT)})${UNIT_END}(?:\\s*(?<v2>\\d{1,2})(?![\\d.])\\s*(?:${alternatives(UNIT_INCH)})?${UNIT_END})?|(?<u>${UNIT_OTHER})${UNIT_END}))?`;

/** "chest 42", "বুকের মাপ ৪২", "লম্বা ৫ ফুট ৬", "waist: 32 inch". */
const MEASURE_AFTER_PART = new RegExp(
  `${START}(?<part>${PART_ANY})${BN_ENDING}(?:[\\s:=\\-–]*(?:${FILLER})${BN_ENDING}(?![\\p{L}\\p{M}])){0,3}[\\s:=\\-–]*${MEASURE_TAIL}`,
  'giud',
);
/** "42 chest", "৩২ ইঞ্চি কোমর". */
const MEASURE_BEFORE_PART = new RegExp(
  `(?<![\\d.\\p{L}])(?<v>${VALUE})(?![\\d])(?!\\.\\d)\\s*(?:(?<u>${alternatives([...UNIT_INCH, ...UNIT_CM])})${UNIT_END}\\s*)?(?<part>${PART_ANY})${END}`,
  'giud',
);
/** A height by its unit alone: "5'6\"", "5 ft 6 in", "৫ ফুট ৬ ইঞ্চি", "5.6 feet". */
const HEIGHT_FEET = new RegExp(
  `(?<![\\d.\\p{L}])(?<v>\\d(?:\\.\\d{1,2})?)\\s*(?:${alternatives(UNIT_FT)})${UNIT_END}(?:\\s*(?<v2>\\d{1,2})(?![\\d.])\\s*(?:${alternatives(UNIT_INCH)})?${UNIT_END})?`,
  'giud',
);
/** A weight by its unit alone: "60 kg", "৬০ কেজি". */
const WEIGHT_KG = new RegExp(
  `(?<![\\d.\\p{L}])(?<v>\\d{1,3}(?:\\.\\d)?)\\s*(?:${alternatives(UNIT_KG)})${UNIT_END}`,
  'giud',
);

/** What a body part can measure, in inches (weight in kg), so "chest 7" is not offered. */
const PLAUSIBLE: Readonly<Record<MeasurementPart, readonly [number, number]>> = {
  chest: [24, 64],
  waist: [20, 60],
  hip: [24, 66],
  length: [12, 60],
  shoulder: [10, 26],
  sleeve: [5, 36],
  height: [36, 90],
  weight: [10, 200],
};

const CM_PER_INCH = 2.54;
const round1 = (value: number) => Math.round(value * 10) / 10;

function unitOf(word: string | undefined): MeasureUnit | null {
  if (word === undefined) return null;
  const key = normaliseWord(word);
  if (UNIT_INCH.some((unit) => normaliseWord(unit) === key)) return 'in';
  if (UNIT_CM.some((unit) => normaliseWord(unit) === key)) return 'cm';
  if (UNIT_KG.some((unit) => normaliseWord(unit) === key)) return 'kg';
  if (UNIT_FT.some((unit) => normaliseWord(unit) === key)) return 'ft';
  return null;
}

/**
 * Feet and inches as inches. "5.6 ft" is read the way it is said here, five feet six inches
 * (D-770), when the decimals are an inch count under 12; "5.75 ft" stays a decimal.
 */
function feetToInches(feet: string, inches: string | undefined): number | null {
  const [whole = '', fraction] = feet.split('.');
  const wholeFeet = Number(whole);
  if (!Number.isFinite(wholeFeet)) return null;
  if (inches !== undefined) {
    if (fraction !== undefined) return null;
    const extra = Number(inches);
    return extra < 12 ? wholeFeet * 12 + extra : null;
  }
  if (fraction === undefined) return wholeFeet * 12;
  const asInches = Number(fraction);
  if (
    fraction.length <= 2 &&
    asInches < 12 &&
    !(fraction.length === 2 && fraction.startsWith('0'))
  ) {
    return wholeFeet * 12 + asInches;
  }
  return round1(Number(feet) * 12);
}

/**
 * One measurement from its part, value and unit, or null when the numbers cannot be that part.
 * No unit: inches for a length, kg for a weight; a value only plausible in centimetres is read
 * as centimetres ("chest 100").
 */
function measurement(
  rawPart: MeasurementPart | 'tall',
  value: string,
  unitWord: string | undefined,
  second: string | undefined,
): {
  part: MeasurementPart;
  value: number;
  unit: MeasureUnit;
  inches: number | null;
  kg: number | null;
} | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  let unit = unitOf(unitWord);
  const part: MeasurementPart =
    rawPart === 'tall'
      ? unit === 'ft' || (unit === null && number >= 3 && number < 8) || number >= 48
        ? 'height'
        : 'length'
      : rawPart;

  if (part === 'weight') {
    if (unit !== null && unit !== 'kg') return null;
    const [low, high] = PLAUSIBLE.weight;
    return number >= low && number <= high
      ? { part, value: number, unit: 'kg', inches: null, kg: number }
      : null;
  }
  if (unit === 'kg') return null;
  if (second !== undefined && unit !== 'ft') return null;

  let inches: number | null;
  if (unit === 'ft') {
    inches = feetToInches(value, second);
  } else if (unit === 'cm') {
    inches = round1(number / CM_PER_INCH);
  } else if (part === 'height' && unit === null && number >= 3 && number < 8) {
    // "উচ্চতা ৫.৬", "height 5": feet, as a height is said.
    unit = 'ft';
    inches = feetToInches(value, undefined);
  } else {
    inches = number;
    if (unit === null) {
      const [low, high] = PLAUSIBLE[part];
      if (
        (number < low || number > high) &&
        number / CM_PER_INCH >= low &&
        number / CM_PER_INCH <= high
      ) {
        unit = 'cm';
        inches = round1(number / CM_PER_INCH);
      } else {
        unit = 'in';
      }
    }
  }
  if (inches === null) return null;
  const [low, high] = PLAUSIBLE[part];
  if (inches < low || inches > high) return null;
  return { part, value: number, unit: unit ?? 'in', inches: round1(inches), kg: null };
}

// --- product references -------------------------------------------------------------------------

/** `ELY-SHRT-0001-RED-M`, `ely-pnj-0042`: letters, then dash-joined parts, one with a digit. */
const SKU_CODE =
  /(?<![\p{L}\p{N}\-/.])(?<code>[A-Za-z]{2,10}(?:-[A-Za-z0-9]{1,12}){1,6})(?![\p{L}\p{N}-])/gu;
const BARCODE = /(?<![\d+])(?<code>\d{13})(?!\d)/gu;
const LINK_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRODUCT_PATH_WORDS = new Set(['product', 'products', 'p', 'item', 'items', 'shop']);

function hostPattern(hosts: readonly string[]): string | null {
  const clean = [
    ...new Set(
      hosts
        .map((host) =>
          host
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, '')
            .replace(/^www\./, ''),
        )
        .filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/.test(host)),
    ),
  ];
  if (clean.length === 0) return null;
  return clean.map(escape).join('|');
}

/** The product's slug in a link to the brand's website, or null for any other page. */
export function slugFromLink(url: string): string | null {
  const path = url
    .replace(/^(?:https?:\/\/)?[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((segment) => segment !== '');
  if (path.length === 0) return null;
  const decoded = path.map((segment) => {
    try {
      return decodeURIComponent(segment).toLowerCase();
    } catch {
      return segment.toLowerCase();
    }
  });
  const marker = decoded.findIndex((segment) => PRODUCT_PATH_WORDS.has(segment));
  const slug = marker >= 0 ? decoded[marker + 1] : decoded[decoded.length - 1];
  if (slug === undefined || PRODUCT_PATH_WORDS.has(slug)) return null;
  return LINK_SEGMENT.test(slug) && slug.length <= 200 ? slug : null;
}

// --- colours -------------------------------------------------------------------------------------

/** How a colour is said in Bangla and Banglish, by its English name. */
const COLOUR_WORDS: Readonly<Record<string, readonly string[]>> = {
  black: ['kalo', 'kala', 'কালো'],
  white: ['sada', 'shada', 'সাদা', 'শাদা'],
  red: ['lal', 'লাল'],
  blue: ['neel', 'নীল'],
  green: ['sobuj', 'shobuj', 'সবুজ'],
  yellow: ['holud', 'হলুদ'],
  pink: ['golapi', 'gulapi', 'গোলাপি', 'গোলাপী'],
  purple: ['beguni', 'বেগুনি', 'বেগুনী'],
  orange: ['komla', 'কমলা'],
  brown: ['khoyeri', 'খয়েরি', 'বাদামি'],
  maroon: ['meroon', 'mehroon', 'মেরুন'],
  grey: ['ash', 'chai rong', 'ছাই', 'ধূসর', 'এশ'],
  gray: ['ash', 'ছাই', 'ধূসর', 'এশ'],
  navy: ['nevy', 'নেভি'],
  cream: ['krim', 'ক্রিম'],
  golden: ['sonali', 'সোনালি', 'সোনালী'],
  silver: ['rupali', 'রুপালি', 'রুপালী'],
  'sky blue': ['akashi', 'আকাশি', 'আকাশী'],
  olive: ['অলিভ'],
  beige: ['বেইজ'],
};

// --- the detector --------------------------------------------------------------------------------

export interface HintDetector {
  /** Every hint in one message, in the order it appears. */
  detect(text: string | null, messageId?: string | null): ChatHint[];
}

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly build: (span: HintSpan, source: string) => ChatHint | null;
}

function spanOf(match: RegExpMatchArray, group?: string): HintSpan | null {
  if (group !== undefined) {
    const range = match.indices?.groups?.[group];
    return range === undefined ? null : { start: range[0], end: range[1] };
  }
  const start = match.index ?? 0;
  return { start, end: start + match[0].length };
}

/**
 * Compile a detector once for a brand (its colours and website); `detect` is then cheap per
 * message. The patterns are tried in a fixed order and a later hint that overlaps an earlier
 * one is dropped: products, then measurements, sizes, quantities and colours ("chest size 42"
 * is a measurement, not size 42; "2XL" is a size, not two of anything).
 */
export function chatHintDetector(options: HintOptions = {}): HintDetector {
  const catalogColours = (options.colours ?? [])
    .map((colour) => colour.trim())
    .filter((colour) => colour !== '' && colour.length <= 60);
  const colourByWord = new Map<string, string>();
  for (const colour of catalogColours) colourByWord.set(normaliseWord(colour), colour);
  for (const [english, words] of Object.entries(COLOUR_WORDS)) {
    const named = colourByWord.get(normaliseWord(english));
    if (named === undefined) continue;
    for (const word of words) {
      const key = normaliseWord(word);
      if (!colourByWord.has(key)) colourByWord.set(key, named);
    }
  }
  const colourWords = [...catalogColours];
  for (const [english, words] of Object.entries(COLOUR_WORDS)) {
    if (colourByWord.has(normaliseWord(english))) colourWords.push(...words);
  }
  const colourPattern =
    colourWords.length === 0
      ? null
      : new RegExp(`${START}(?<colour>${alternatives(colourWords)})${END}`, 'giud');

  const hosts = hostPattern(options.siteHosts ?? []);
  const linkPattern =
    hosts === null
      ? null
      : new RegExp(
          `(?<![\\p{L}\\p{N}.])(?:https?:\\/\\/)?(?:www\\.)?(?:${hosts})(?:\\/[^\\s<>"'()]*)?`,
          'giu',
        );

  return {
    detect(text, messageId = null) {
      if (typeof text !== 'string' || text === '') return [];
      const original = text.slice(0, HINT_SCAN_LIMIT);
      const scanned = asciiDigitsIn(original);
      const groups: Candidate[][] = [[], [], [], [], []];
      const [products, measures, sizes, quantities, colours] = groups as [
        Candidate[],
        Candidate[],
        Candidate[],
        Candidate[],
        Candidate[],
      ];

      // Products: the brand's links, then barcodes and SKU-like codes.
      if (linkPattern !== null) {
        for (const match of scanned.matchAll(linkPattern)) {
          const span = spanOf(match);
          if (span === null) continue;
          const url = original.slice(span.start, span.end).replace(/[.,!?;:]+$/, '');
          const slug = slugFromLink(url);
          if (slug === null) continue;
          products.push({
            start: span.start,
            end: span.start + url.length,
            build: (at, source) => ({
              kind: 'product',
              messageId,
              span: at,
              source,
              ref: { type: 'link', slug, url },
            }),
          });
        }
      }
      for (const match of scanned.matchAll(BARCODE)) {
        const code = match.groups?.code ?? '';
        const span = spanOf(match);
        // `8801712345678` is a phone written without its plus, not a barcode.
        if (span === null || code.startsWith('880') || !isValidEan13(code)) continue;
        products.push({
          ...span,
          build: (at, source) => ({
            kind: 'product',
            messageId,
            span: at,
            source,
            ref: { type: 'barcode', barcode: code },
          }),
        });
      }
      for (const match of scanned.matchAll(SKU_CODE)) {
        const code = (match.groups?.code ?? '').toUpperCase();
        const span = spanOf(match);
        if (span === null || !/\d/.test(code) || code.length > 64) continue;
        products.push({
          ...span,
          build: (at, source) => ({
            kind: 'product',
            messageId,
            span: at,
            source,
            ref: { type: 'code', code },
          }),
        });
      }

      // Measurements.
      const addMeasure = (match: RegExpMatchArray, part: MeasurementPart | 'tall'): void => {
        const span = spanOf(match);
        const value = match.groups?.v;
        if (span === null || value === undefined) return;
        const read = measurement(
          part,
          value,
          match.groups?.u ?? match.groups?.ft,
          match.groups?.v2,
        );
        if (read === null) return;
        measures.push({
          ...span,
          build: (at, source) => ({ kind: 'measurement', messageId, span: at, source, ...read }),
        });
      };
      for (const match of scanned.matchAll(MEASURE_AFTER_PART)) {
        const part = partByWord.get(normaliseWord(match.groups?.part ?? ''));
        if (part !== undefined) addMeasure(match, part);
      }
      for (const match of scanned.matchAll(MEASURE_BEFORE_PART)) {
        const part = partByWord.get(normaliseWord(match.groups?.part ?? ''));
        if (part !== undefined && part !== 'tall' && part !== 'weight' && part !== 'height') {
          addMeasure(match, part);
        }
      }
      for (const match of scanned.matchAll(HEIGHT_FEET)) {
        const span = spanOf(match);
        const value = match.groups?.v;
        if (span === null || value === undefined) continue;
        const read = measurement('height', value, 'ft', match.groups?.v2);
        if (read === null) continue;
        measures.push({
          ...span,
          build: (at, source) => ({ kind: 'measurement', messageId, span: at, source, ...read }),
        });
      }
      for (const match of scanned.matchAll(WEIGHT_KG)) addMeasure(match, 'weight');

      // Sizes.
      const addSize = (match: RegExpMatchArray, group: string, size: string | null): void => {
        const span = spanOf(match, group);
        if (span === null || size === null) return;
        sizes.push({
          ...span,
          build: (at, source) => ({ kind: 'size', messageId, span: at, source, size }),
        });
      };
      for (const match of scanned.matchAll(SIZE_AFTER_WORD)) {
        addSize(match, 'size', canonicalSize(match.groups?.size ?? ''));
      }
      for (const match of scanned.matchAll(SIZE_BEFORE_WORD)) {
        addSize(match, 'size', canonicalSize(match.groups?.size ?? ''));
      }
      for (const match of scanned.matchAll(SIZE_ALONE)) {
        addSize(match, 'size', canonicalSize(match.groups?.size ?? ''));
      }
      for (const match of scanned.matchAll(SIZE_ADJECTIVE)) {
        addSize(match, 'size', canonicalSize(match.groups?.size ?? ''));
      }
      for (const match of scanned.matchAll(SIZE_NUMBER)) {
        const group = match.groups?.after !== undefined ? 'after' : 'before';
        const number = Number(match.groups?.[group]);
        if (number >= NUMERIC_SIZE_MIN && number <= NUMERIC_SIZE_MAX) {
          addSize(match, group, String(number));
        }
      }
      if (original.trim().length <= SHORT_MESSAGE) {
        for (const match of scanned.matchAll(SIZE_CAPITAL)) {
          addSize(match, 'size', canonicalSize(match.groups?.size ?? ''));
        }
      }

      // Quantities.
      const addQty = (match: RegExpMatchArray, group: string, qty: number | undefined): void => {
        const span = spanOf(match, group === '' ? undefined : group);
        if (span === null || qty === undefined) return;
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_HINT_QTY) return;
        quantities.push({
          ...span,
          build: (at, source) => ({ kind: 'quantity', messageId, span: at, source, qty }),
        });
      };
      for (const match of scanned.matchAll(QTY_DIGITS)) {
        const qty = Number(match.groups?.n);
        const piece = normaliseWord(match.groups?.piece ?? '');
        // "1 ta" is plain talk ("1ta kotha"); a one needs a real piece word.
        if (qty === 1 && !STRICT_PIECE_WORD.some((word) => normaliseWord(word) === piece)) continue;
        addQty(match, '', qty);
      }
      for (const match of scanned.matchAll(QTY_LABELLED)) {
        addQty(match, '', Number(match.groups?.n));
      }
      for (const match of scanned.matchAll(QTY_COUNTED)) {
        addQty(match, '', countByWord.get(normaliseWord(match.groups?.word ?? '')));
      }
      for (const match of scanned.matchAll(QTY_WORDED)) {
        const qty = countByWord.get(normaliseWord(match.groups?.word ?? ''));
        const piece = normaliseWord(match.groups?.piece ?? '');
        if (qty === 1 && !STRICT_PIECE_WORD.some((word) => normaliseWord(word) === piece)) continue;
        addQty(match, '', qty);
      }
      for (const match of scanned.matchAll(QTY_BEFORE_SIZE)) {
        addQty(match, 'n', Number(match.groups?.n));
      }
      for (const match of scanned.matchAll(QTY_BEFORE_CAPITAL)) {
        addQty(match, 'n', Number(match.groups?.n));
      }

      // Colours.
      if (colourPattern !== null) {
        for (const match of scanned.matchAll(colourPattern)) {
          const span = spanOf(match, 'colour');
          const colour = colourByWord.get(normaliseWord(match.groups?.colour ?? ''));
          if (span === null || colour === undefined) continue;
          colours.push({
            ...span,
            build: (at, source) => ({ kind: 'colour', messageId, span: at, source, colour }),
          });
        }
      }

      // Earlier groups win an overlap; within a group the first (then longest) wins.
      const taken: HintSpan[] = [];
      const out: ChatHint[] = [];
      for (const group of groups) {
        const ordered = [...group].sort((a, b) => a.start - b.start || b.end - a.end);
        for (const candidate of ordered) {
          if (taken.some((span) => candidate.start < span.end && span.start < candidate.end)) {
            continue;
          }
          const span = { start: candidate.start, end: candidate.end };
          const hint = candidate.build(span, original.slice(span.start, span.end));
          if (hint === null) continue;
          taken.push(span);
          out.push(hint);
        }
      }
      return out.sort((a, b) => a.span.start - b.span.start);
    },
  };
}

/** One message's hints, with a detector compiled for the call. */
export function detectHints(text: string | null, options: HintOptions = {}): ChatHint[] {
  return chatHintDetector(options).detect(text);
}

/** Every message's hints, oldest message first (the order given), each tagged with its id. */
export function hintsInMessages(
  messages: readonly { readonly id: string; readonly text: string | null }[],
  options: HintOptions | HintDetector = {},
): ChatHint[] {
  const detector = 'detect' in options ? options : chatHintDetector(options);
  return messages.flatMap((message) => detector.detect(message.text, message.id));
}

export interface HintSummary {
  /** The newest of each kind, so "L … no, XL" is XL. */
  readonly size: SizeHint | null;
  readonly quantity: QuantityHint | null;
  readonly colour: ColourHint | null;
  /** The newest of each body part, in `MEASUREMENT_PARTS` order. */
  readonly measurements: readonly MeasurementHint[];
  /** Each product once, newest first. */
  readonly products: readonly ProductHint[];
  /** Whether there is anything to offer. */
  readonly empty: boolean;
}

const refKey = (ref: ProductRef) =>
  ref.type === 'code'
    ? `code:${ref.code}`
    : ref.type === 'barcode'
      ? `barcode:${ref.barcode}`
      : `link:${ref.slug}`;

/** Hints in message order (oldest first), reduced to what the side card offers. */
export function summariseHints(hints: readonly ChatHint[]): HintSummary {
  let size: SizeHint | null = null;
  let quantity: QuantityHint | null = null;
  let colour: ColourHint | null = null;
  const measures = new Map<MeasurementPart, MeasurementHint>();
  const products = new Map<string, ProductHint>();
  for (const hint of hints) {
    switch (hint.kind) {
      case 'size':
        size = hint;
        break;
      case 'quantity':
        quantity = hint;
        break;
      case 'colour':
        colour = hint;
        break;
      case 'measurement':
        measures.set(hint.part, hint);
        break;
      case 'product':
        products.delete(refKey(hint.ref));
        products.set(refKey(hint.ref), hint);
        break;
    }
  }
  const measurements = MEASUREMENT_PARTS.flatMap((part) => {
    const found = measures.get(part);
    return found === undefined ? [] : [found];
  });
  const productList = [...products.values()].reverse();
  return {
    size,
    quantity,
    colour,
    measurements,
    products: productList,
    empty:
      size === null &&
      quantity === null &&
      colour === null &&
      measurements.length === 0 &&
      productList.length === 0,
  };
}
