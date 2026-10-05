import { MAX_POISHA, type Poisha } from '../money/index.js';

/**
 * The storefront product list's parameters (M33, D-506): what `GET /storefront/v1/catalog/
 * products` accepts, parsed in one place so the rules are tested rather than scattered over a
 * controller.
 *
 * Strict on shape, lenient on absence. A parameter the website sends wrongly (`limit=-4`, a
 * price in taka with a decimal point, a cursor from another sort) is a bug in the website
 * and answers 400 naming the parameter, rather than a silently different page — the old site
 * quietly ignored such things and the shop then looked "randomly empty". An absent parameter
 * takes its default. Unknown parameters are ignored: a website forwards its own query string
 * and should not have to strip `utm_source` first.
 */

export const STOREFRONT_SORTS = [
  'newest',
  'oldest',
  'price-asc',
  'price-desc',
  'featured',
  'name',
] as const;
export type StorefrontSort = (typeof STOREFRONT_SORTS)[number];

export const STOREFRONT_GENDERS = ['men', 'women', 'kids', 'unisex'] as const;
export type StorefrontGender = (typeof STOREFRONT_GENDERS)[number];

export const STOREFRONT_LIMIT_DEFAULT = 24;
export const STOREFRONT_LIMIT_MAX = 60;
/** Numbered pages stop here; deeper than this is a crawler, and the cursor serves it. */
export const STOREFRONT_PAGE_MAX = 100;
export const SEARCH_TOKENS_MAX = 8;
const TOKEN_LENGTH_MAX = 50;
const TAGS_MAX = 10;

/**
 * Where a page ends, for each sort. The sort is inside the cursor, so a cursor taken under
 * one sort is refused under another rather than misread.
 */
export type StorefrontCursor =
  | { readonly sort: 'newest' | 'oldest'; readonly createdAt: string; readonly id: string }
  | { readonly sort: 'price-asc' | 'price-desc'; readonly pricePoisha: string; readonly id: string }
  | {
      readonly sort: 'featured';
      readonly featured: boolean;
      readonly createdAt: string;
      readonly id: string;
    }
  | { readonly sort: 'name'; readonly name: string; readonly id: string };

export interface StorefrontProductQuery {
  /** A category slug or id; the list covers its whole subtree. */
  readonly category: string | null;
  readonly gender: StorefrontGender | null;
  /** Products carrying every one of these tags. */
  readonly tags: readonly string[];
  /** A size label (`M`, `XL`): products with an active SKU in that size. */
  readonly size: string | null;
  readonly minPricePoisha: Poisha | null;
  readonly maxPricePoisha: Poisha | null;
  readonly featured: boolean;
  readonly newArrival: boolean;
  /** Products with a live offer. Matches nothing until M35's flash sales exist. */
  readonly onSale: boolean;
  /** Search words, every one of which must match. Empty: no search. */
  readonly search: readonly string[];
  readonly sort: StorefrontSort;
  readonly limit: number;
  readonly cursor: StorefrontCursor | null;
  /** A numbered page, for a shop that shows "page 3 of 7". Ignored when a cursor is sent. */
  readonly page: number | null;
}

export interface QueryProblem {
  readonly param: string;
  readonly message: string;
}

type Params = Readonly<Record<string, string | readonly string[] | undefined>>;

function one(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : value[value.length - 1];
  return text === undefined || text.trim() === '' ? undefined : text.trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Search words: lower-cased, at most eight, each at most fifty characters. */
export function searchTokens(input: string | null | undefined): string[] {
  if (input === null || input === undefined) return [];
  const words = input
    // Control characters are no part of a word, and PostgreSQL refuses a NUL outright.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.slice(0, TOKEN_LENGTH_MAX))
    .filter((word) => word !== '');
  return [...new Set(words)].slice(0, SEARCH_TOKENS_MAX);
}

/** A word escaped for a SQL `like` pattern (`\` as the escape), so `%` and `_` are literal. */
export function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function flag(params: Params, name: string, problems: QueryProblem[]): boolean {
  const value = one(params, name);
  if (value === undefined) return false;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  problems.push({ param: name, message: `${name} is true or false.` });
  return false;
}

function price(params: Params, name: string, problems: QueryProblem[]): Poisha | null {
  const value = one(params, name);
  if (value === undefined) return null;
  if (!/^\d{1,16}$/.test(value) || BigInt(value) > MAX_POISHA) {
    problems.push({ param: name, message: `${name} is a whole number of poisha.` });
    return null;
  }
  return BigInt(value) as Poisha;
}

function integer(
  params: Params,
  name: string,
  bounds: { readonly min: number; readonly max: number },
  problems: QueryProblem[],
): number | null {
  const value = one(params, name);
  if (value === undefined) return null;
  const parsed = /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    problems.push({
      param: name,
      message: `${name} is a whole number from ${String(bounds.min)} to ${String(bounds.max)}.`,
    });
    return null;
  }
  return parsed;
}

/** Parse the list's query string. `problems` is empty when the request is well formed. */
export function parseStorefrontQuery(params: Params): {
  readonly query: StorefrontProductQuery;
  readonly problems: readonly QueryProblem[];
} {
  const problems: QueryProblem[] = [];

  // A NUL reaches PostgreSQL as a refused parameter (a 500); it is never in a real value.
  for (const [name, value] of Object.entries(params)) {
    const values = value === undefined ? [] : typeof value === 'string' ? [value] : value;
    if (values.some((text) => text.includes('\u0000'))) {
      problems.push({ param: name, message: `${name} holds a character that is not allowed.` });
    }
  }

  const category = one(params, 'category') ?? null;
  if (category !== null && !UUID.test(category) && !SLUG.test(category)) {
    problems.push({ param: 'category', message: 'category is a category slug or id.' });
  }

  const genderText = one(params, 'gender');
  const gender =
    genderText === undefined
      ? null
      : (STOREFRONT_GENDERS as readonly string[]).includes(genderText)
        ? (genderText as StorefrontGender)
        : null;
  if (genderText !== undefined && gender === null) {
    problems.push({
      param: 'gender',
      message: `gender is one of ${STOREFRONT_GENDERS.join(', ')}.`,
    });
  }

  const tagText = one(params, 'tags');
  const tags =
    tagText === undefined
      ? []
      : [
          ...new Set(
            tagText
              .split(',')
              .map((tag) => tag.trim().toLowerCase())
              .filter((tag) => tag !== ''),
          ),
        ];
  if (tags.length > TAGS_MAX || tags.some((tag) => tag.length > 40)) {
    problems.push({ param: 'tags', message: 'tags is at most ten comma-separated tags.' });
  }

  const size = one(params, 'size') ?? null;
  if (size !== null && size.length > 60) {
    problems.push({ param: 'size', message: 'size is a size label.' });
  }

  const minPricePoisha = price(params, 'minPricePoisha', problems);
  const maxPricePoisha = price(params, 'maxPricePoisha', problems);
  if (minPricePoisha !== null && maxPricePoisha !== null && minPricePoisha > maxPricePoisha) {
    problems.push({ param: 'minPricePoisha', message: 'minPricePoisha is above maxPricePoisha.' });
  }

  const sortText = one(params, 'sort') ?? 'newest';
  const sort = (STOREFRONT_SORTS as readonly string[]).includes(sortText)
    ? (sortText as StorefrontSort)
    : 'newest';
  if (sort !== sortText) {
    problems.push({ param: 'sort', message: `sort is one of ${STOREFRONT_SORTS.join(', ')}.` });
  }

  const limit =
    integer(params, 'limit', { min: 1, max: STOREFRONT_LIMIT_MAX }, problems) ??
    STOREFRONT_LIMIT_DEFAULT;
  const page = integer(params, 'page', { min: 1, max: STOREFRONT_PAGE_MAX }, problems);

  const cursorText = one(params, 'cursor');
  const cursor = cursorText === undefined ? null : decodeStorefrontCursor(cursorText, sort);
  if (cursorText !== undefined && cursor === null) {
    problems.push({
      param: 'cursor',
      message: 'cursor is not one this list issued for this sort.',
    });
  }

  return {
    query: {
      category,
      gender,
      tags,
      size,
      minPricePoisha,
      maxPricePoisha,
      featured: flag(params, 'featured', problems),
      newArrival: flag(params, 'newArrival', problems),
      onSale: flag(params, 'onSale', problems),
      search: searchTokens(one(params, 'q') ?? one(params, 'search')),
      sort,
      limit,
      cursor,
      page: cursor === null ? page : null,
    },
    problems,
  };
}

// --- the cursor ---------------------------------------------------------------------------

const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** An instant the database will accept: the shape, and a real date and time. */
const ISO = {
  test(text: string): boolean {
    if (!ISO_SHAPE.test(text)) return false;
    const parsed = new Date(text);
    return (
      !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === text.slice(0, 19)
    );
  },
};

/** A cursor as the opaque string the API returns. */
export function encodeStorefrontCursor(cursor: StorefrontCursor): string {
  return base64url(JSON.stringify(cursorParts(cursor)));
}

function cursorParts(cursor: StorefrontCursor): readonly (string | boolean)[] {
  switch (cursor.sort) {
    case 'newest':
    case 'oldest':
      return [cursor.sort, cursor.createdAt, cursor.id];
    case 'price-asc':
    case 'price-desc':
      return [cursor.sort, cursor.pricePoisha, cursor.id];
    case 'featured':
      return [cursor.sort, cursor.featured, cursor.createdAt, cursor.id];
    case 'name':
      return [cursor.sort, cursor.name, cursor.id];
  }
}

/** The cursor a string carries, or null when it is not one issued for `sort`. */
export function decodeStorefrontCursor(
  text: string,
  sort: StorefrontSort,
): StorefrontCursor | null {
  if (text.length > 600 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let parts: unknown;
  try {
    parts = JSON.parse(fromBase64url(text));
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts[0] !== sort) return null;
  const id: unknown = parts[parts.length - 1];
  if (typeof id !== 'string' || !UUID.test(id)) return null;

  switch (sort) {
    case 'newest':
    case 'oldest': {
      const [, createdAt] = parts as unknown[];
      if (parts.length !== 3 || typeof createdAt !== 'string' || !ISO.test(createdAt)) return null;
      return { sort, createdAt, id };
    }
    case 'price-asc':
    case 'price-desc': {
      const [, pricePoisha] = parts as unknown[];
      if (parts.length !== 3 || typeof pricePoisha !== 'string' || !/^\d{1,16}$/.test(pricePoisha))
        return null;
      return { sort, pricePoisha, id };
    }
    case 'featured': {
      const [, featured, createdAt] = parts as unknown[];
      if (
        parts.length !== 4 ||
        typeof featured !== 'boolean' ||
        typeof createdAt !== 'string' ||
        !ISO.test(createdAt)
      )
        return null;
      return { sort, featured, createdAt, id };
    }
    case 'name': {
      const [, name] = parts as unknown[];
      if (parts.length !== 3 || typeof name !== 'string' || name.length > 200) return null;
      if (name.includes('\u0000')) return null;
      return { sort, name, id };
    }
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url over UTF-8, without padding. Written out so the package needs no Buffer. */
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const remaining = bytes.length - index;
    out += B64[(triple >> 18) & 63] ?? '';
    out += B64[(triple >> 12) & 63] ?? '';
    if (remaining > 1) out += B64[(triple >> 6) & 63] ?? '';
    if (remaining > 2) out += B64[triple & 63] ?? '';
  }
  return out;
}

function fromBase64url(text: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = B64.indexOf(char);
    if (value < 0) throw new Error('not base64url');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
}
