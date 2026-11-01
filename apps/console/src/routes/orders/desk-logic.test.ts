import { describe, expect, it } from 'vitest';

import { bulkRefusals } from './desk-logic.js';

/** A bulk press says what it could not do, order by order (M52, D-941). */
describe('bulkRefusals', () => {
  const ok = { ok: true } as const;
  const no = (message: string) => ({ ok: false, message }) as const;

  it('says nothing when everything went through', () => {
    expect(bulkRefusals([ok, ok])).toBe('');
  });

  it('gives each refusal in its own words, leaving out what worked', () => {
    expect(bulkRefusals([no('Order A has 8 pieces.'), ok, no('Order B is sold out.')])).toBe(
      'Order A has 8 pieces. Order B is sold out.',
    );
  });

  it('stops at five and says how many more', () => {
    const many = ['1', '2', '3', '4', '5', '6', '7'].map(no);
    expect(bulkRefusals(many)).toBe('1 2 3 4 5 (+2)');
  });
});
