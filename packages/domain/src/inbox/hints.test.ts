import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  canonicalSize,
  chartLayout,
  chatHintDetector,
  detectHints,
  draftTotals,
  hintsInMessages,
  MAX_HINT_QTY,
  parseChartCell,
  recommendSize,
  sameSize,
  slugFromLink,
  summariseHints,
  type MeasurementHint,
} from './index.js';

/**
 * M44b's detection (check 4, D-770), size from a size chart (D-771) and the draft's totals
 * (D-773): examples in English, Bangla and Banglish, then properties over generated chats.
 */

const BANGLA = '০১২৩৪৫৬৭৮৯';
const toBangla = (digits: string) => digits.replace(/\d/g, (d) => BANGLA[Number(d)] ?? d);

const COLOURS = ['Black', 'White', 'Navy Blue', 'Maroon', 'Off White'];
const detector = chatHintDetector({ colours: COLOURS, siteHosts: ['https://www.elysiam.com/'] });
const read = (text: string) => detector.detect(text);
const sizes = (text: string) =>
  read(text).flatMap((hint) => (hint.kind === 'size' ? [hint.size] : []));
const qtys = (text: string) =>
  read(text).flatMap((hint) => (hint.kind === 'quantity' ? [hint.qty] : []));
const measures = (text: string) =>
  read(text).filter((hint): hint is MeasurementHint => hint.kind === 'measurement');

describe('sizes (M44b check 4)', () => {
  it.each([
    ['XL', 'XL'],
    ['xl', 'XL'],
    ['ami XL nibo', 'XL'],
    ['L size', 'L'],
    ['l size er dam koto?', 'L'],
    ['size M', 'M'],
    ['size: m', 'M'],
    ['M chai', 'M'],
    ['2XL ache?', 'XXL'],
    ['XXL', 'XXL'],
    ['3xl', 'XXXL'],
    ['double xl', 'XXL'],
    ['medium dien', 'M'],
    ['large ache?', 'L'],
    ['ami medium nibo', 'M'],
    ['size small', 'S'],
    ['extra large', 'XL'],
    ['free size?', 'FREE'],
    ['এক্সএল', 'XL'],
    ['এক্সএলটা দিন', 'XL'],
    ['এল সাইজ', 'L'],
    ['সাইজ এম', 'M'],
    ['এম লাগবে', 'M'],
    ['মিডিয়াম', 'M'],
    ['ডাবল এক্সএল', 'XXL'],
    ['ফ্রি সাইজ', 'FREE'],
    ['size 40', '40'],
    ['৪২ সাইজ', '42'],
    ['সাইজ ৩৮', '38'],
    ['40 number ta den', '40'],
    ['L', 'L'],
    ['M please', 'M'],
  ])('%s → %s', (text, size) => {
    expect(sizes(text)).toEqual([size]);
  });

  it.each([
    'I am coming',
    'ami asbo',
    'Mirpur 10',
    'Lalbagh',
    'is it available?',
    'এল', // "came", not a size, without a size word
    'এস কথা বলি',
    'my name is Mahmud and I live in Mirpur, please call me on the number below', // long: no bare M
    'size koto?',
    'ekta small problem hoyeche',
    'large amount of money',
    '1200 taka',
  ])('%s → no size', (text) => {
    expect(sizes(text)).toEqual([]);
  });

  it('canonical sizes match the catalog however they are written', () => {
    expect(canonicalSize('2XL')).toBe('XXL');
    expect(canonicalSize('xxl')).toBe('XXL');
    expect(canonicalSize('Free Size')).toBe('FREE');
    expect(canonicalSize('৪০')).toBe('40');
    expect(canonicalSize('Large')).toBe('L');
    expect(canonicalSize('Navy')).toBeNull();
    expect(sameSize('XXL', '2XL')).toBe(true);
    expect(sameSize('L', 'XL')).toBe(false);
  });
});

describe('quantities (M44b check 4)', () => {
  it.each([
    ['2 ta', 2],
    ['2ta lagbe', 2],
    ['২টা', 2],
    ['২ টা দিন', 2],
    ['3 pcs', 3],
    ['3pcs', 3],
    ['two pieces', 2],
    ['duita', 2],
    ['dui ta', 2],
    ['দুইটা', 2],
    ['দুটো দিবেন', 2],
    ['তিনটি', 3],
    ['qty 4', 4],
    ['quantity: 5', 5],
    ['1 pcs', 1],
    ['ekta piece', 1],
    ['এক পিস', 1],
    ['2 XL', 2],
  ])('%s → %d', (text, qty) => {
    expect(qtys(text)).toEqual([qty]);
  });

  it.each(['ekta kotha', 'একটা প্রশ্ন', '1 ta kotha', '2 tarikh', '1200 taka', 'tin din', '2XL'])(
    '%s → no quantity',
    (text) => {
      expect(qtys(text)).toEqual([]);
    },
  );
});

describe('measurements (M44b check 4)', () => {
  const one = (text: string) => {
    const found = measures(text);
    expect(found, text).toHaveLength(1);
    return found[0]!;
  };

  it('reads a chest however it is said', () => {
    for (const text of [
      'chest 42',
      'Chest: 42',
      'chest 42 inch',
      'buker map 42',
      'বুকের মাপ ৪২',
      'বুক ৪২ ইঞ্চি',
      '42 chest',
    ]) {
      const found = one(text);
      expect([found.part, found.inches, found.unit], text).toEqual(['chest', 42, 'in']);
    }
  });

  it('reads centimetres, stated or plain', () => {
    expect(one('chest 107 cm').inches).toBeCloseTo(42.1, 1);
    expect(one('chest 107').unit).toBe('cm');
  });

  it('reads a height in feet and inches, Bangla and the local "5.6"', () => {
    expect(one('লম্বা ৫ ফুট ৬').inches).toBe(66);
    expect(one('height 5\'6"').inches).toBe(66);
    expect(one('5 ft 6 in').inches).toBe(66);
    expect(one('উচ্চতা ৫.৪').inches).toBe(64);
    expect(one('lomba 5.6 feet').part).toBe('height');
  });

  it('reads a weight', () => {
    const found = one('৬০ কেজি');
    expect([found.part, found.kg]).toEqual(['weight', 60]);
    expect(one('weight 72').kg).toBe(72);
    expect(one('ওজন ৬৫ কেজি').kg).toBe(65);
  });

  it('reads lengths, waists and shoulders', () => {
    expect(one('length 30').part).toBe('length');
    expect(one('লম্বা ৪২').part).toBe('length');
    expect(one('komor 32').part).toBe('waist');
    expect(one('কোমর ৩২').inches).toBe(32);
    expect(one('shoulder 18').part).toBe('shoulder');
  });

  it('keeps the chest and the count apart', () => {
    const found = read('chest 42 inch 2 ta');
    expect(found.map((hint) => hint.kind)).toEqual(['measurement', 'quantity']);
  });

  it('refuses numbers a body part cannot measure', () => {
    expect(measures('chest 7')).toEqual([]);
    expect(measures('waist 300')).toEqual([]);
    expect(measures('2 ft')).toEqual([]);
    expect(measures('how long 2 days')).toEqual([]);
    expect(measures('long 15 days lagbe?')).toEqual([]);
    expect(measures('chest 42 taka')).toEqual([]);
  });
});

describe('colours and products', () => {
  it('reads catalog colours, in Bangla and Banglish too', () => {
    const colours = (text: string) =>
      read(text).flatMap((hint) => (hint.kind === 'colour' ? [hint.colour] : []));
    expect(colours('black ta dien')).toEqual(['Black']);
    expect(colours('kalo ta')).toEqual(['Black']);
    expect(colours('সাদা')).toEqual(['White']);
    expect(colours('navy blue XL')).toEqual(['Navy Blue']);
    expect(colours('off white')).toEqual(['Off White']);
    // Red is not one of this brand's colours.
    expect(colours('lal ta')).toEqual([]);
  });

  it('reads SKU codes, barcodes and links to the brand website', () => {
    const refs = (text: string) =>
      read(text).flatMap((hint) => (hint.kind === 'product' ? [hint.ref] : []));
    expect(refs('ELY-PNJ-0042-M ache?')).toEqual([{ type: 'code', code: 'ELY-PNJ-0042-M' }]);
    expect(refs('ely-pnj-0042')).toEqual([{ type: 'code', code: 'ELY-PNJ-0042' }]);
    expect(refs('2000000000015')).toEqual([{ type: 'barcode', barcode: '2000000000015' }]);
    expect(refs('8801712345678')).toEqual([]);
    expect(refs('https://www.elysiam.com/product/eid-panjabi-blue?fbclid=x this one')).toEqual([
      {
        type: 'link',
        slug: 'eid-panjabi-blue',
        url: 'https://www.elysiam.com/product/eid-panjabi-blue?fbclid=x',
      },
    ]);
    expect(refs('elysiam.com/products/kurta-1')).toEqual([
      { type: 'link', slug: 'kurta-1', url: 'elysiam.com/products/kurta-1' },
    ]);
    expect(refs('https://example.com/product/eid-panjabi')).toEqual([]);
    expect(refs('https://www.elysiam.com/')).toEqual([]);
  });

  it('takes a product slug from a link', () => {
    expect(slugFromLink('https://shop.test/product/abc-1')).toBe('abc-1');
    expect(slugFromLink('https://shop.test/abc-1/')).toBe('abc-1');
    expect(slugFromLink('https://shop.test/')).toBeNull();
    expect(slugFromLink('https://shop.test/product')).toBeNull();
  });
});

describe('a whole request (M44b check 4)', () => {
  it('reads "XL", the count and the chest from one Bangla message, with spans', () => {
    const text = 'আমার বুকের মাপ ৪২, এক্সএল সাইজের ২টা দিবেন';
    const found = read(text);
    expect(found.map((hint) => hint.kind)).toEqual(['measurement', 'size', 'quantity']);
    for (const hint of found) expect(text.slice(hint.span.start, hint.span.end)).toBe(hint.source);
    const summary = summariseHints(found);
    expect(summary.size?.size).toBe('XL');
    expect(summary.quantity?.qty).toBe(2);
    expect(summary.measurements[0]?.inches).toBe(42);
  });

  it('the newest message wins, and each hint names its message', () => {
    const hints = hintsInMessages(
      [
        { id: 'a', text: 'L size 2 ta' },
        { id: 'b', text: null },
        { id: 'c', text: 'na XL den, 3 pcs' },
      ],
      detector,
    );
    const summary = summariseHints(hints);
    expect(summary.size).toMatchObject({ size: 'XL', messageId: 'c' });
    expect(summary.quantity).toMatchObject({ qty: 3, messageId: 'c' });
    expect(summariseHints([]).empty).toBe(true);
  });

  it('works with no catalog colours and no website', () => {
    expect(detectHints('black XL').map((hint) => hint.kind)).toEqual(['size']);
  });
});

// --- properties --------------------------------------------------------------------------------

/** Text with no digits, letters A–Z or Bangla, so it cannot carry a hint of its own. */
const quiet = fc
  .array(fc.constantFrom(' ', ',', '!', '?', '.', '\n', '·', '—', 'ঃ'), { maxLength: 6 })
  .map((chars) => chars.join(''));

const SIZE_FORMS: readonly (readonly [string, string])[] = [
  ['XL', 'XL'],
  ['xl', 'XL'],
  ['L size', 'L'],
  ['size M', 'M'],
  ['এক্সএল', 'XL'],
  ['এল সাইজ', 'L'],
  ['2XL', 'XXL'],
  ['XXL', 'XXL'],
  ['মিডিয়াম', 'M'],
  ['free size', 'FREE'],
];

describe('properties (fast-check)', () => {
  it('never throws, and every span is inside the text and reads back as its source', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const found = read(text);
        for (const hint of found) {
          expect(hint.span.start).toBeGreaterThanOrEqual(0);
          expect(hint.span.end).toBeLessThanOrEqual(text.length);
          expect(hint.span.start).toBeLessThan(hint.span.end);
          expect(text.slice(hint.span.start, hint.span.end)).toBe(hint.source);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('hints never overlap, and come in reading order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom(...SIZE_FORMS.map(([form]) => form)),
            fc.constantFrom(
              '2 ta',
              '২টা',
              'duita',
              '3 pcs',
              'chest 42',
              'বুকের মাপ ৪২',
              '৬০ কেজি',
              'kalo',
              'ELY-PNJ-0042',
            ),
            fc.string({ maxLength: 8 }),
          ),
          { maxLength: 8 },
        ),
        (parts) => {
          const found = read(parts.join(' '));
          for (let index = 1; index < found.length; index += 1) {
            const before = found[index - 1]!;
            const hint = found[index]!;
            expect(before.span.end).toBeLessThanOrEqual(hint.span.start);
          }
        },
      ),
    );
  });

  it('finds a size however it is written, among words that mean nothing', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SIZE_FORMS), quiet, quiet, ([form, size], before, after) => {
        expect(sizes(`${before} ${form} ${after}`)).toEqual([size]);
      }),
    );
  });

  it('a count with its classifier is that count, in either script', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: MAX_HINT_QTY }),
        fc.constantFrom(' ta', 'ta', ' টা', 'টা', ' pcs', ' piece', 'টি', ' পিস'),
        fc.boolean(),
        quiet,
        (qty, piece, bangla, around) => {
          const number = bangla ? toBangla(String(qty)) : String(qty);
          expect(qtys(`${around} ${number}${piece} ${around}`)).toEqual([qty]);
        },
      ),
    );
  });

  it('a chest in inches reads back the same in Bangla digits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 24, max: 64 }),
        fc.constantFrom('chest', 'বুক', 'বুকের মাপ', 'buk'),
        (inches, word) => {
          const ascii = measures(`${word} ${String(inches)}`);
          const bangla = measures(`${word} ${toBangla(String(inches))}`);
          expect(ascii.map((hint) => hint.inches)).toEqual([inches]);
          expect(bangla.map((hint) => hint.inches)).toEqual([inches]);
        },
      ),
    );
  });

  it('a height in feet and inches is twelve times the feet plus the inches', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 6 }),
        fc.integer({ min: 0, max: 11 }),
        fc.boolean(),
        (feet, inches, bangla) => {
          const text = `${String(feet)} ফুট ${String(inches)} ইঞ্চি`;
          const found = measures(bangla ? toBangla(text) : text);
          expect(found.map((hint) => [hint.part, hint.inches])).toEqual([
            ['height', feet * 12 + inches],
          ]);
        },
      ),
    );
  });

  it('a phone number is never a quantity, a size, a measurement or a barcode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('3', '4', '5', '6', '7', '8', '9'),
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 }),
        fc.constantFrom('0', '+880', '880'),
        fc.boolean(),
        (operator, rest, prefix, bangla) => {
          const phone = `${prefix}1${operator}${rest.join('')}`;
          expect(read(`call ${bangla ? toBangla(phone) : phone}`)).toEqual([]);
        },
      ),
    );
  });
});

describe('size from a size chart (D-771)', () => {
  const panjabi = {
    columns: ['Size', 'Chest (inch)', 'Length', 'Shoulder'],
    rows: [
      ['M', '40', '40', '17'],
      ['L', '42', '42', '18'],
      ['XL', '44', '43', '19'],
      ['2XL', '46-48', '44', '20'],
    ],
  };
  const chest = (inches: number) => ({ part: 'chest' as const, inches, kg: null });

  it('reads the layout and the cells', () => {
    const layout = chartLayout(panjabi);
    expect(layout.sizeIndex).toBe(0);
    expect(layout.parts.map((column) => [column.part, column.unit])).toEqual([
      ['chest', 'in'],
      ['length', 'in'],
      ['shoulder', 'in'],
    ]);
    expect(parseChartCell('46-48', 'chest')).toMatchObject({ low: 46, high: 48 });
    expect(parseChartCell('৪০ - ৪২', 'chest')).toMatchObject({ low: 40, high: 42 });
    expect(parseChartCell(`5'4"-5'6"`, 'height')).toMatchObject({ low: 64, high: 66 });
    expect(parseChartCell('n/a', 'chest')).toBeNull();
  });

  it('chest 42 is L, 43 rounds up to XL, 47 is 2XL, over the chart is none', () => {
    expect(recommendSize(panjabi, [chest(42)])).toMatchObject({ size: 'L', decidedBy: 'chest' });
    expect(recommendSize(panjabi, [chest(43)]).fits[0]).toMatchObject({
      size: 'XL',
      reason: 'between',
    });
    expect(recommendSize(panjabi, [chest(47)])).toMatchObject({ size: '2XL', canonical: 'XXL' });
    expect(recommendSize(panjabi, [chest(36)]).fits[0]).toMatchObject({
      size: 'M',
      reason: 'below_chart',
    });
    expect(recommendSize(panjabi, [chest(50)])).toMatchObject({ size: null });
  });

  it('the largest size among the measurements decides', () => {
    const result = recommendSize(panjabi, [chest(40), { part: 'shoulder', inches: 19, kg: null }]);
    expect(result).toMatchObject({ size: 'XL', decidedBy: 'shoulder' });
  });

  it('reads a chart in centimetres from an inch measurement', () => {
    const cm = {
      columns: ['Size', 'Chest (cm)'],
      rows: [
        ['M', '102'],
        ['L', '107'],
        ['XL', '112'],
      ],
    };
    expect(recommendSize(cm, [chest(42)]).size).toBe('L');
  });

  it('says nothing for a measurement the chart has no column for', () => {
    expect(recommendSize(panjabi, [{ part: 'weight', inches: null, kg: 70 }])).toMatchObject({
      size: null,
      fits: [{ part: 'weight', reason: 'no_column' }],
    });
  });

  it('the recommended size always fits the measurement, or is the smallest', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 30, max: 60 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 24, max: 64 }),
        (values, inches) => {
          const sorted = [...new Set(values)].sort((a, b) => a - b);
          const chart = {
            columns: ['Size', 'Chest'],
            rows: sorted.map((value, index) => [`S${String(index)}`, String(value)]),
          };
          const result = recommendSize(chart, [chest(inches)]);
          const largest = sorted[sorted.length - 1] ?? 0;
          if (inches > largest) {
            expect(result.size).toBeNull();
            return;
          }
          const index = Number((result.size ?? 'S-1').slice(1));
          expect(sorted[index]).toBeGreaterThanOrEqual(inches);
          if (index > 0) expect(sorted[index - 1]).toBeLessThan(inches);
        },
      ),
    );
  });
});

describe('the draft totals (D-773)', () => {
  const p = (value: number) => poisha(value);

  it('adds lines, takes the discount and the code, adds the delivery, and sets the advance apart', () => {
    const totals = draftTotals({
      lines: [
        { unitPricePoisha: p(150_000), qty: 2 },
        { unitPricePoisha: p(99_900), qty: 1 },
      ],
      discountPoisha: p(10_000),
      deliveryPoisha: p(12_000),
      promo: { discountPoisha: p(5_000), deliveryDiscountPoisha: p(2_000) },
      advancePoisha: p(20_000),
    });
    expect(totals.itemsPoisha).toBe(399_900n);
    expect(totals.discountPoisha).toBe(15_000n);
    expect(totals.deliveryPoisha).toBe(10_000n);
    expect(totals.totalPoisha).toBe(394_900n);
    expect(totals.toCollectPoisha).toBe(374_900n);
    expect(totals.problems).toEqual([]);
  });

  it('names what the server would refuse', () => {
    expect(
      draftTotals({ lines: [], discountPoisha: p(0), deliveryPoisha: p(0), advancePoisha: p(0) })
        .problems,
    ).toEqual(['no_lines']);
    expect(
      draftTotals({
        lines: [{ unitPricePoisha: p(100), qty: 1 }],
        discountPoisha: p(200),
        deliveryPoisha: p(0),
        advancePoisha: p(0),
      }).problems,
    ).toEqual(['discount_exceeds_items']);
  });

  it('total = items − discount + delivery; lines add up; nothing is ever negative', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            price: fc.integer({ min: 0, max: 50_000_000 }),
            qty: fc.integer({ min: 1, max: 999 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        (lines, discount, delivery, advance) => {
          const totals = draftTotals({
            lines: lines.map((line) => ({ unitPricePoisha: p(line.price), qty: line.qty })),
            discountPoisha: p(discount),
            deliveryPoisha: p(delivery),
            advancePoisha: p(advance),
          });
          const items = lines.reduce(
            (sum, line) => sum + BigInt(line.price) * BigInt(line.qty),
            0n,
          );
          expect(totals.itemsPoisha).toBe(items);
          expect(totals.lineTotals.reduce((a, b) => a + b, 0n)).toBe(items);
          const raw = items - BigInt(discount) + BigInt(delivery);
          expect(totals.totalPoisha).toBe(raw < 0n ? 0n : raw);
          expect(totals.problems.includes('discount_exceeds_items')).toBe(BigInt(discount) > items);
          expect(totals.toCollectPoisha >= 0n).toBe(true);
          expect(
            totals.toCollectPoisha +
              (totals.advancePoisha > totals.totalPoisha
                ? totals.totalPoisha
                : totals.advancePoisha),
          ).toBe(totals.totalPoisha);
        },
      ),
    );
  });
});
