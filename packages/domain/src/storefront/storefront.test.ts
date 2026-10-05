import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha, type Poisha } from '../money/index.js';
import {
  availableForWeb,
  availableQtyFor,
  buildCategoryTree,
  buildNav,
  decodeStorefrontCursor,
  encodeStorefrontCursor,
  escapeLike,
  isSafeSiteLink,
  navProblems,
  normaliseTags,
  parseStorefrontQuery,
  recordSlugChange,
  releaseSlug,
  resolveSlug,
  searchTokens,
  shippingFeeFor,
  shippingRuleProblems,
  shipsFree,
  sizeChartProblems,
  SLUG_HISTORY_LIMIT,
  STOREFRONT_SORTS,
  storefrontPrice,
  takaDecimal,
  visibleSubtreeIds,
  webZoneFor,
  wireMoney,
  type CategoryNode,
  type NavItemRow,
  type ShippingRule,
  type StockLevel,
  type StorefrontCursor,
} from './index.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describe('availableForWeb', () => {
  const level = (skuId: string, locationId: string, onHand: number, reserved: number) => ({
    skuId,
    locationId,
    onHand,
    reserved,
  });

  it('sums on hand less reserved over the web locations only', () => {
    const levels = [
      level('a', 'wh', 10, 3),
      level('a', 'shop', 50, 0),
      level('a', 'wh2', 4, 4),
      level('b', 'shop', 9, 0),
    ];
    const available = availableForWeb(levels, ['wh', 'wh2']);
    expect(available.get('a')).toBe(7);
    // A SKU with stock only off the web locations is present, at zero.
    expect(available.get('b')).toBe(0);
    expect(availableQtyFor('a', levels, ['wh'])).toBe(7);
    expect(availableQtyFor('missing', levels, ['wh'])).toBe(0);
  });

  const levelArb = fc.record({
    skuId: fc.constantFrom('a', 'b', 'c'),
    locationId: fc.constantFrom('l1', 'l2', 'l3', 'l4'),
    onHand: fc.integer({ min: -5, max: 500 }),
    reserved: fc.integer({ min: -5, max: 600 }),
  });

  it('is never negative, whatever the rows say', () => {
    fc.assert(
      fc.property(
        fc.array(levelArb, { maxLength: 40 }),
        fc.subarray(['l1', 'l2', 'l3', 'l4']),
        (levels, web) => {
          for (const qty of availableForWeb(levels, web).values()) {
            expect(qty).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(qty)).toBe(true);
          }
        },
      ),
    );
  });

  it('equals the healthy per-location sum, and adding a web location never lowers it', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .record({
              skuId: fc.constantFrom('a', 'b'),
              locationId: fc.constantFrom('l1', 'l2', 'l3'),
              onHand: fc.integer({ min: 0, max: 200 }),
            })
            .chain((row) =>
              fc.integer({ min: 0, max: row.onHand }).map((reserved) => ({ ...row, reserved })),
            ),
          { maxLength: 30 },
        ),
        fc.subarray(['l1', 'l2', 'l3']),
        (levels: StockLevel[], web) => {
          const got = availableForWeb(levels, web);
          for (const sku of ['a', 'b']) {
            const expected = levels
              .filter((row) => row.skuId === sku && web.includes(row.locationId))
              .reduce((total, row) => total + row.onHand - row.reserved, 0);
            if (levels.some((row) => row.skuId === sku)) expect(got.get(sku)).toBe(expected);
            const wider = availableForWeb(levels, [...web, 'l1', 'l2', 'l3']);
            expect(wider.get(sku) ?? 0).toBeGreaterThanOrEqual(got.get(sku) ?? 0);
          }
          // Listing a location twice counts it once.
          expect(availableForWeb(levels, [...web, ...web])).toEqual(got);
        },
      ),
    );
  });
});

describe('storefrontPrice and the wire format', () => {
  it('is the shelf price with nothing on offer', () => {
    expect(storefrontPrice({ id: 's', pricePoisha: poisha(150_000) })).toEqual({
      pricePoisha: 150_000n,
      compareAtPoisha: null,
    });
  });

  it('takes the lowest offer below the shelf price and ignores the rest', () => {
    const sku = { id: 's', pricePoisha: poisha(150_000) };
    expect(
      storefrontPrice(sku, [
        { skuId: 's', pricePoisha: poisha(120_000) },
        { skuId: 's', pricePoisha: poisha(110_000) },
        { skuId: 's', pricePoisha: poisha(160_000) },
        { skuId: 'other', pricePoisha: poisha(1_000) },
      ]),
    ).toEqual({ pricePoisha: 110_000n, compareAtPoisha: 150_000n });
  });

  it('never charges more than the shelf price', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.array(fc.bigInt({ min: -10n, max: 20_000_000n })),
        (shelf, offers) => {
          const price = storefrontPrice(
            { id: 's', pricePoisha: shelf as Poisha },
            offers.map((value) => ({ skuId: 's', pricePoisha: value as Poisha })),
          );
          expect(price.pricePoisha <= shelf).toBe(true);
          expect(price.pricePoisha > 0n).toBe(true);
          if (price.compareAtPoisha !== null) expect(price.compareAtPoisha).toBe(shelf);
        },
      ),
    );
  });

  it('writes taka from the integer parts, round-tripping every amount', () => {
    expect(takaDecimal(poisha(125_050))).toBe('1250.50');
    expect(takaDecimal(poisha(5))).toBe('0.05');
    expect(wireMoney('100')).toEqual({ poisha: '100', taka: '1.00' });
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 9_000_000_000_000_000n }), (value) => {
        const text = takaDecimal(value as Poisha);
        expect(text).toMatch(/^\d+\.\d{2}$/);
        expect(BigInt(text.replace('.', ''))).toBe(value);
      }),
    );
  });
});

describe('old addresses', () => {
  it('keeps the slug a product leaves, newest first, and never its own current slug', () => {
    expect(recordSlugChange([], 'blue-shirt', 'navy-shirt')).toEqual(['blue-shirt']);
    expect(recordSlugChange(['blue-shirt'], 'navy-shirt', 'blue-shirt')).toEqual(['navy-shirt']);
    expect(recordSlugChange(['a', 'b'], 'c', 'c')).toEqual(['a', 'b']);
    expect(releaseSlug(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('resolves current first, then a unique old address, else nothing', () => {
    const owners = [
      { id: 'p1', slug: 'navy', previousSlugs: ['blue'] },
      { id: 'p2', slug: 'red', previousSlugs: [] },
    ];
    expect(resolveSlug('navy', owners)).toEqual({ kind: 'current', id: 'p1' });
    expect(resolveSlug('blue', owners)).toEqual({ kind: 'redirect', id: 'p1', slug: 'navy' });
    expect(resolveSlug('green', owners)).toEqual({ kind: 'none' });
    // A broken invariant answers nothing rather than guessing.
    expect(
      resolveSlug('x', [
        { id: 'a', slug: 'a', previousSlugs: ['x'] },
        { id: 'b', slug: 'b', previousSlugs: ['x'] },
      ]),
    ).toEqual({ kind: 'none' });
  });

  /**
   * The rule the migration's trigger implements, run as a model: random renames across a few
   * products with a small alphabet of slugs, so collisions and renames back are common.
   */
  it('keeps every slug in at most one place, and every old address leads somewhere true', () => {
    const SLUGS = ['a', 'b', 'c', 'd', 'e', 'f'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ product: fc.integer({ min: 0, max: 3 }), slug: fc.constantFrom(...SLUGS) }),
          {
            maxLength: 60,
          },
        ),
        (renames) => {
          const products = [0, 1, 2, 3].map((index) => ({
            id: `p${String(index)}`,
            slug: `start-${String(index)}`,
            previousSlugs: [] as string[],
          }));
          // Who stood at each address last: where an old address must lead.
          const lastHolder = new Map<string, string>(
            products.map((product) => [product.slug, product.id]),
          );
          for (const { product, slug } of renames) {
            const target = products[product];
            if (target === undefined) continue;
            // The unique index: another product's current slug cannot be taken.
            if (products.some((other) => other !== target && other.slug === slug)) continue;
            const from = target.slug;
            target.previousSlugs = recordSlugChange(target.previousSlugs, from, slug);
            target.slug = slug;
            for (const other of products) {
              if (other !== target) other.previousSlugs = releaseSlug(other.previousSlugs, slug);
            }
            lastHolder.set(slug, target.id);
          }

          const places = new Map<string, number>();
          for (const product of products) {
            expect(product.previousSlugs.length).toBeLessThanOrEqual(SLUG_HISTORY_LIMIT);
            for (const slug of [product.slug, ...product.previousSlugs]) {
              places.set(slug, (places.get(slug) ?? 0) + 1);
            }
          }
          for (const count of places.values()) expect(count).toBe(1);

          // Six slugs never overflow the history, so every address ever used still leads to
          // the product that stood there last: itself when it is still there, else a redirect.
          for (const [slug, holderId] of lastHolder) {
            const holder = products.find((candidate) => candidate.id === holderId);
            const answer = resolveSlug(slug, products);
            if (holder?.slug === slug) {
              expect(answer).toEqual({ kind: 'current', id: holderId });
            } else {
              expect(answer).toEqual({ kind: 'redirect', id: holderId, slug: holder?.slug });
            }
          }
        },
      ),
    );
  });
});

describe('the shipping rule', () => {
  const rule = (overrides: Partial<ShippingRule> = {}): ShippingRule => ({
    freeShippingEnabled: false,
    freeShippingThresholdPoisha: null,
    zones: {
      inside_dhaka: { feePoisha: poisha(6_000), deliveryZoneIds: ['z1'] },
      suburbs: { feePoisha: poisha(10_000), deliveryZoneIds: ['z2'] },
      outside_dhaka: { feePoisha: poisha(13_000), deliveryZoneIds: ['z3'] },
    },
    ...overrides,
  });

  it('charges the website zone the ERP zone falls in', () => {
    expect(webZoneFor(rule(), 'z2')).toBe('suburbs');
    expect(webZoneFor(rule(), 'z9')).toBeNull();
    expect(shippingFeeFor(rule(), 'z3', poisha(500_000))).toBe(13_000n);
    expect(shippingFeeFor(rule(), 'z9', poisha(500_000))).toBeNull();
  });

  it('ships free at the threshold, and always when the threshold is zero', () => {
    const free = rule({ freeShippingEnabled: true, freeShippingThresholdPoisha: poisha(150_000) });
    expect(shippingFeeFor(free, 'z1', poisha(149_999))).toBe(6_000n);
    expect(shippingFeeFor(free, 'z1', poisha(150_000))).toBe(0n);
    expect(
      shipsFree(
        rule({ freeShippingEnabled: true, freeShippingThresholdPoisha: poisha(0) }),
        poisha(1),
      ),
    ).toBe(true);
    expect(shipsFree(rule({ freeShippingThresholdPoisha: poisha(0) }), poisha(1))).toBe(false);
  });

  it('refuses unknown zones, a zone in two places and negative figures', () => {
    expect(shippingRuleProblems(rule(), ['z1', 'z2', 'z3'])).toEqual([]);
    const bad = rule({
      freeShippingThresholdPoisha: -1n as Poisha,
      zones: {
        inside_dhaka: { feePoisha: -5n as Poisha, deliveryZoneIds: ['z1', 'z2'] },
        suburbs: { feePoisha: poisha(1), deliveryZoneIds: ['z2'] },
        outside_dhaka: { feePoisha: poisha(1), deliveryZoneIds: ['nope'] },
      },
    });
    const codes = shippingRuleProblems(bad, ['z1', 'z2', 'z3']).map((problem) => problem.code);
    expect(codes.sort()).toEqual(
      ['FEE_OUT_OF_RANGE', 'THRESHOLD_OUT_OF_RANGE', 'ZONE_IN_TWO_PLACES', 'ZONE_UNKNOWN'].sort(),
    );
  });

  it('never charges a negative fee, and a valid rule maps each zone to at most one place', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.bigInt({ min: 0n, max: 10_000_000n }), { nil: null }),
        fc.array(fc.bigInt({ min: 0n, max: 100_000n }), { minLength: 3, maxLength: 3 }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (enabled, threshold, fees, total) => {
          const candidate: ShippingRule = {
            freeShippingEnabled: enabled,
            freeShippingThresholdPoisha: threshold as Poisha | null,
            zones: {
              inside_dhaka: { feePoisha: (fees[0] ?? 0n) as Poisha, deliveryZoneIds: ['z1'] },
              suburbs: { feePoisha: (fees[1] ?? 0n) as Poisha, deliveryZoneIds: ['z2'] },
              outside_dhaka: { feePoisha: (fees[2] ?? 0n) as Poisha, deliveryZoneIds: ['z3'] },
            },
          };
          expect(shippingRuleProblems(candidate, ['z1', 'z2', 'z3'])).toEqual([]);
          for (const zone of ['z1', 'z2', 'z3']) {
            const fee = shippingFeeFor(candidate, zone, total as Poisha);
            expect(fee).not.toBeNull();
            expect((fee ?? -1n) >= 0n).toBe(true);
          }
        },
      ),
    );
  });
});

describe('the product list parameters', () => {
  it('takes defaults for what is absent and ignores what it does not know', () => {
    const { query, problems } = parseStorefrontQuery({ utm_source: 'fb' });
    expect(problems).toEqual([]);
    expect(query).toMatchObject({
      category: null,
      gender: null,
      tags: [],
      sort: 'newest',
      limit: 24,
      cursor: null,
      page: null,
      featured: false,
      search: [],
    });
  });

  it('parses every filter', () => {
    const { query, problems } = parseStorefrontQuery({
      category: 'menswear',
      gender: 'men',
      tags: 'Summer, cotton,summer',
      size: 'XL',
      minPricePoisha: '50000',
      maxPricePoisha: '300000',
      featured: 'true',
      newArrival: '1',
      onSale: 'false',
      q: '  Blue   COTTON shirt ',
      sort: 'price-asc',
      limit: '12',
      page: '3',
    });
    expect(problems).toEqual([]);
    expect(query).toMatchObject({
      category: 'menswear',
      gender: 'men',
      tags: ['summer', 'cotton'],
      size: 'XL',
      minPricePoisha: 50_000n,
      maxPricePoisha: 300_000n,
      featured: true,
      newArrival: true,
      onSale: false,
      search: ['blue', 'cotton', 'shirt'],
      sort: 'price-asc',
      limit: 12,
      page: 3,
    });
  });

  it('names every malformed parameter', () => {
    const { problems } = parseStorefrontQuery({
      category: 'Not A Slug',
      gender: 'robots',
      minPricePoisha: '12.50',
      maxPricePoisha: '-3',
      sort: 'random',
      limit: '500',
      page: '0',
      featured: 'yes',
      cursor: 'garbage!',
    });
    expect(problems.map((problem) => problem.param).sort()).toEqual(
      [
        'category',
        'cursor',
        'featured',
        'gender',
        'limit',
        'maxPricePoisha',
        'minPricePoisha',
        'page',
        'sort',
      ].sort(),
    );
  });

  it('refuses a price range that runs backwards', () => {
    const { problems } = parseStorefrontQuery({ minPricePoisha: '5', maxPricePoisha: '4' });
    expect(problems.map((problem) => problem.param)).toEqual(['minPricePoisha']);
  });

  it('never accepts a limit or a page outside its bounds', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), (limit, page) => {
        const { query } = parseStorefrontQuery({ limit, page });
        expect(query.limit).toBeGreaterThanOrEqual(1);
        expect(query.limit).toBeLessThanOrEqual(60);
        if (query.page !== null) {
          expect(query.page).toBeGreaterThanOrEqual(1);
          expect(query.page).toBeLessThanOrEqual(100);
        }
      }),
    );
  });

  it('splits search words, caps them and escapes like-patterns', () => {
    expect(searchTokens('a  B a')).toEqual(['a', 'b']);
    expect(searchTokens('1 2 3 4 5 6 7 8 9 10')).toHaveLength(8);
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  const cursorArb: fc.Arbitrary<StorefrontCursor> = fc.oneof(
    fc.record({
      sort: fc.constantFrom('newest' as const, 'oldest' as const),
      createdAt: fc
        .date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true })
        .map((date) => date.toISOString()),
      id: fc.uuid(),
    }),
    fc.record({
      sort: fc.constantFrom('price-asc' as const, 'price-desc' as const),
      pricePoisha: fc.bigInt({ min: 0n, max: 9_000_000_000_000_000n }).map(String),
      id: fc.uuid(),
    }),
    fc.record({
      sort: fc.constant('featured' as const),
      featured: fc.boolean(),
      createdAt: fc
        .date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true })
        .map((date) => date.toISOString()),
      id: fc.uuid(),
    }),
    fc.record({
      sort: fc.constant('name' as const),
      name: fc.string({ maxLength: 200 }),
      id: fc.uuid(),
    }),
  );

  it('round-trips every cursor, and refuses it under any other sort', () => {
    fc.assert(
      fc.property(cursorArb, (cursor) => {
        const text = encodeStorefrontCursor(cursor);
        expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeStorefrontCursor(text, cursor.sort)).toEqual(cursor);
        for (const other of STOREFRONT_SORTS) {
          if (other !== cursor.sort) expect(decodeStorefrontCursor(text, other)).toBeNull();
        }
      }),
    );
  });

  it('never throws on a hostile cursor', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 700 }),
        fc.constantFrom(...STOREFRONT_SORTS),
        (text, sort) => {
          expect(() => decodeStorefrontCursor(text, sort)).not.toThrow();
        },
      ),
    );
  });

  it('refuses a NUL in any parameter, and a cursor with an impossible date', () => {
    const { problems } = parseStorefrontQuery({ q: 'a\u0000b', size: 'M\u0000' });
    expect(problems.map((problem) => problem.param).sort()).toEqual(['q', 'size']);
    expect(searchTokens('a\u0000b')).toEqual(['a', 'b']);
    const impossible = encodeStorefrontCursor({
      sort: 'newest',
      createdAt: '2026-13-45T99:99:99Z',
      id: uuid(2),
    });
    expect(decodeStorefrontCursor(impossible, 'newest')).toBeNull();
    expect(parseStorefrontQuery({ cursor: impossible }).problems.map((p) => p.param)).toEqual([
      'cursor',
    ]);
  });

  it('drops a page number when a cursor is sent', () => {
    const cursor = encodeStorefrontCursor({
      sort: 'newest',
      createdAt: '2026-10-05T00:00:00.000Z',
      id: uuid(1),
    });
    const { query, problems } = parseStorefrontQuery({ cursor, page: '4' });
    expect(problems).toEqual([]);
    expect(query.page).toBeNull();
    expect(query.cursor).not.toBeNull();
  });
});

describe('content rules', () => {
  it('normalises tags idempotently', () => {
    expect(normaliseTags([' Summer ', 'summer', 'Cotton  Blend', '!!!', 'x'.repeat(41)])).toEqual([
      'summer',
      'cotton blend',
    ]);
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 50 }), { maxLength: 60 }), (input) => {
        const once = normaliseTags(input);
        expect(normaliseTags(once)).toEqual(once);
        expect(once.length).toBeLessThanOrEqual(30);
        for (const tag of once) expect(tag).toBe(tag.toLowerCase());
      }),
    );
  });

  it('allows only site paths and https links', () => {
    for (const good of ['/', '/shop?category=men', 'https://example.com/a?b=c']) {
      expect(isSafeSiteLink(good)).toBe(true);
    }
    for (const bad of [
      'javascript:alert(1)',
      '//evil.example',
      'http://example.com',
      'data:text/html,x',
      ' /shop',
      '/shop\nx',
      '/\\evil',
      'https://user:pw@example.com',
      '',
    ]) {
      expect(isSafeSiteLink(bad)).toBe(false);
    }
    fc.assert(
      fc.property(fc.string(), (text) => {
        if (isSafeSiteLink(text)) {
          expect(text.startsWith('/') || text.startsWith('https://')).toBe(true);
          expect(text.startsWith('//')).toBe(false);
        }
      }),
    );
  });

  it('checks a size chart’s grid', () => {
    expect(sizeChartProblems({ columns: ['Size', 'Chest'], rows: [['M', '40']] })).toEqual([]);
    expect(sizeChartProblems({ columns: [], rows: [] })).toHaveLength(1);
    expect(sizeChartProblems({ columns: ['Size', 'Chest'], rows: [['M']] })).toEqual([
      'Every row has one cell per column.',
    ]);
  });

  const cat = (
    id: number,
    parentId: number | null,
    position: number,
    visible = true,
    name = `c${String(id)}`,
  ): CategoryNode => ({
    id: uuid(id),
    parentId: parentId === null ? null : uuid(parentId),
    name,
    slug: name,
    position,
    visible,
  });

  it('builds the visible category tree, a hidden parent hiding its subtree', () => {
    const rows = [
      cat(1, null, 1),
      cat(2, null, 0),
      cat(3, 1, 0),
      cat(4, 3, 0),
      cat(5, null, 2, false),
      cat(6, 5, 0),
    ];
    const tree = buildCategoryTree(rows);
    expect(tree.map((node) => node.id)).toEqual([uuid(2), uuid(1)]);
    expect(tree[1]?.children[0]?.children[0]?.id).toBe(uuid(4));
    expect(visibleSubtreeIds(rows, uuid(1))).toEqual([uuid(1), uuid(3), uuid(4)]);
    expect(visibleSubtreeIds(rows, uuid(5))).toEqual([]);
    expect(visibleSubtreeIds(rows, uuid(6))).toEqual([]);
  });

  it('never shows a category whose ancestor is hidden', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 7 }), fc.boolean(), fc.integer({ min: 0, max: 5 })),
          {
            minLength: 1,
            maxLength: 12,
          },
        ),
        (spec) => {
          // Parent always has a lower index, so the rows form a forest.
          const rows = spec.map(([parent, visible, position], index) =>
            cat(index + 1, index === 0 || parent >= index ? null : parent + 1, position, visible),
          );
          const shown = new Set<string>();
          const walk = (nodes: readonly ReturnType<typeof buildCategoryTree>[number][]): void => {
            for (const node of nodes) {
              shown.add(node.id);
              walk(node.children);
            }
          };
          walk(buildCategoryTree(rows));
          for (const row of rows) {
            let ancestorHidden = false;
            let current: CategoryNode | undefined = row;
            while (current !== undefined) {
              if (!current.visible) ancestorHidden = true;
              const parentId: string | null = current.parentId;
              current = rows.find((candidate) => candidate.id === parentId);
            }
            expect(shown.has(row.id)).toBe(!ancestorHidden);
          }
        },
      ),
    );
  });

  const item = (overrides: Partial<NavItemRow> & { id: string }): NavItemRow => ({
    parentId: null,
    kind: 'link',
    label: 'Label',
    href: '/',
    categoryId: null,
    highlighted: false,
    isActive: true,
    position: 0,
    ...overrides,
  });

  it('builds the menu: order, category labels and subcategories, empty dropdowns dropped', () => {
    const categories = [
      cat(1, null, 0, true, 'men'),
      cat(2, 1, 0, true, 'shirts'),
      cat(3, 2, 0, true, 'casual'),
      cat(4, 3, 0, true, 'deep'),
      cat(9, null, 0, false, 'hidden'),
    ];
    const nav = buildNav(
      [
        item({ id: 'b', position: 2, label: 'Sale', href: '/shop?onSale=true', highlighted: true }),
        item({
          id: 'a',
          position: 1,
          kind: 'category',
          label: null,
          href: null,
          categoryId: uuid(1),
        }),
        item({ id: 'h', position: 3, kind: 'category', categoryId: uuid(9) }),
        item({ id: 'd', position: 4, kind: 'dropdown', label: 'More', href: null }),
        item({ id: 'e', position: 5, kind: 'dropdown', label: 'Help', href: null }),
        item({ id: 'e1', parentId: 'e', label: 'Size guide', href: '/size-guide' }),
        item({ id: 'off', position: 0, isActive: false }),
      ],
      categories,
    );
    expect(nav.map((entry) => entry.id)).toEqual(['a', 'b', 'e']);
    expect(nav[0]?.label).toBe('men');
    expect(nav[0]?.subcategories[0]?.slug).toBe('shirts');
    expect(nav[0]?.subcategories[0]?.children[0]?.slug).toBe('casual');
    expect(nav[0]?.subcategories[0]?.children[0]?.children).toEqual([]);
    expect(nav[2]?.children.map((child) => child.label)).toEqual(['Size guide']);
  });

  it('refuses a menu deeper than two levels or a link that is not safe', () => {
    expect(
      navProblems([
        item({ id: 'd', kind: 'dropdown', href: null }),
        item({ id: 'd2', kind: 'dropdown', parentId: 'd', href: null }),
        item({ id: 'x', parentId: 'd2' }),
        item({ id: 'bad', href: 'javascript:alert(1)' }),
        item({ id: 'c', kind: 'category', categoryId: null }),
        item({ id: 'under-link', parentId: 'bad' }),
      ]),
    ).toEqual([
      'A dropdown cannot sit inside another.',
      'The menu is two levels deep at most.',
      'A link item needs a path on the site or an https:// address.',
      'A category item needs a category.',
      'Only a dropdown holds other items.',
    ]);
  });
});
