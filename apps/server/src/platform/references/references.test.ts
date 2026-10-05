import { SYSTEM_SMS_TEMPLATE_KEYS } from '@elysium/domain/notify';
import { describe, expect, it } from 'vitest';

import { nextFreeSlug } from '../../modules/catalog/catalog-deletes.service.js';
import { LOAN_REMINDER_TEMPLATE } from '../../modules/loans/reminders.service.js';
import { OCCASION_TEMPLATES } from '../../modules/orders/crm.service.js';
import {
  blocking,
  describeUses,
  isStillReferenced,
  mergeUses,
  ReferenceRegistry,
  USAGE_EXAMPLES,
} from './references.js';

/** The pieces of the references port that need no database (M39a, D-621). */
describe('merging what every module said', () => {
  it('adds counts by reason, drops zeros, keeps a few distinct examples, and is movable only if every part is', () => {
    const merged = mergeUses([
      { reason: 'products', count: 2, examples: [{ id: 'a', label: 'A' }], movable: true },
      {
        reason: 'products',
        count: 1,
        examples: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        movable: true,
      },
      { reason: 'order_lines', count: 0 },
      { reason: 'discounts', count: 1 },
    ]);
    expect(merged).toEqual([
      {
        reason: 'products',
        count: 3,
        examples: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        movable: true,
      },
      { reason: 'discounts', count: 1, examples: [], movable: false },
    ]);
    expect(blocking(merged).map((use) => use.reason)).toEqual(['discounts']);
  });

  it('caps the examples', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      label: String(index),
    }));
    expect(mergeUses([{ reason: 'leads', count: 12, examples: many }])[0]?.examples).toHaveLength(
      USAGE_EXAMPLES,
    );
  });

  it('says the counts in words, singular and plural', () => {
    expect(
      describeUses(
        mergeUses([
          { reason: 'stock_movements', count: 3 },
          { reason: 'order_lines', count: 1 },
          { reason: 'discounts', count: 2 },
        ]),
      ),
    ).toBe('3 stock movements, 1 order line and 2 discounts');
    expect(describeUses(mergeUses([{ reason: 'products', count: 1 }]))).toBe('1 product');
  });
});

describe('the registry', () => {
  it('asks every checker in turn and refuses a module registering twice', async () => {
    const registry = new ReferenceRegistry<'thing'>('test');
    const released: string[] = [];
    registry.register({
      module: 'one',
      references: () => Promise.resolve([{ reason: 'orders', count: 1 }]),
      release: (_tx, _org, _kind, ids) => {
        released.push(...ids);
        return Promise.resolve();
      },
    });
    registry.register({
      module: 'two',
      references: () => Promise.resolve([{ reason: 'orders', count: 2 }]),
    });
    expect(() =>
      registry.register({ module: 'one', references: () => Promise.resolve([]) }),
    ).toThrow(/already/);
    const tx = {} as Parameters<typeof registry.references>[0];
    expect(await registry.references(tx, 'org', 'thing', ['x'])).toEqual([
      { reason: 'orders', count: 3, examples: [], movable: false },
    ]);
    expect(await registry.references(tx, 'org', 'thing', [])).toEqual([]);
    await registry.release(tx, 'org', 'thing', ['x']);
    expect(released).toEqual(['x']);
    expect(registry.modules()).toEqual(['one', 'two']);
  });
});

describe('the 23503 backstop', () => {
  const pgError = (code: string, message: string) => {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
  };

  it('is a delete refused by a foreign key or by one of 0119’s guards, found through the wrapper', () => {
    const refused = pgError(
      '23503',
      'update or delete on table "skus" violates foreign key constraint "x" on table "y"',
    );
    expect(isStillReferenced(new Error('Failed query', { cause: refused }))).toBe(true);
    expect(
      isStillReferenced(pgError('23503', 'INVENTORY_IN_USE: a stock level holding 2 pieces')),
    ).toBe(true);
  });

  it('is not an insert naming a row that is not there, nor any other error', () => {
    expect(
      isStillReferenced(
        pgError('23503', 'insert or update on table "products" violates foreign key constraint'),
      ),
    ).toBe(false);
    expect(isStillReferenced(pgError('23505', 'duplicate key'))).toBe(false);
    expect(isStillReferenced('not an error')).toBe(false);
  });
});

describe('the next free address (D-626, D-623)', () => {
  it('suffixes -2, -3 and stays within 120 characters', () => {
    expect(nextFreeSlug('black-panjabi', new Set())).toBe('black-panjabi');
    expect(nextFreeSlug('black-panjabi', new Set(['black-panjabi']))).toBe('black-panjabi-2');
    expect(nextFreeSlug('black-panjabi', new Set(['black-panjabi', 'black-panjabi-2']))).toBe(
      'black-panjabi-3',
    );
    const long = 'a'.repeat(120);
    const next = nextFreeSlug(long, new Set([long]));
    expect(next).toHaveLength(120);
    expect(next.endsWith('-2')).toBe(true);
  });
});

describe('the system’s own SMS templates (D-632)', () => {
  it('lists every key the CRM and the loan reminders send, so none of them is deletable', () => {
    for (const key of [...Object.values(OCCASION_TEMPLATES), LOAN_REMINDER_TEMPLATE]) {
      expect(SYSTEM_SMS_TEMPLATE_KEYS).toContain(key);
    }
  });
});
