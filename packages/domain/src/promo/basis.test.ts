import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import { promoBasis } from './index.js';

const line = (skuId: string, net: number) => ({ skuId, netPoisha: poisha(net) });

describe('promoBasis', () => {
  it('leaves the lines alone when there is no order discount', () => {
    expect(promoBasis([line('a', 100_000)], poisha(0))).toEqual([line('a', 100_000)]);
  });

  it('takes the agent’s discount off before the code is priced', () => {
    // ৳10,000 brought down to ৳1,500: the code sees ৳1,500.
    expect(promoBasis([line('a', 1_000_000)], poisha(850_000))).toEqual([line('a', 150_000)]);
  });

  it('spreads the discount by each line’s share, so an out-of-scope line carries its part', () => {
    // ৳4,000 and ৳1,000, ৳500 off: ৳400 and ৳100.
    expect(promoBasis([line('a', 400_000), line('b', 100_000)], poisha(50_000))).toEqual([
      line('a', 360_000),
      line('b', 90_000),
    ]);
  });

  it('clamps a discount larger than the basket to the basket', () => {
    expect(promoBasis([line('a', 1_000), line('b', 3_000)], poisha(9_999))).toEqual([
      line('a', 0),
      line('b', 0),
    ]);
  });

  it('refuses a negative discount', () => {
    expect(() => promoBasis([line('a', 1_000)], poisha(-1))).toThrow(RangeError);
  });

  it('takes off exactly the discount, never makes a line negative, and keeps the lines', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5_000_000 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 80_000_000 }),
        (nets, discount) => {
          const lines = nets.map((net, index) => line(`s${String(index)}`, net));
          const before = nets.reduce((sum, net) => sum + BigInt(net), 0n);
          const after = promoBasis(lines, poisha(discount));
          const left = after.reduce((sum, entry) => sum + entry.netPoisha, 0n);
          const taken = BigInt(discount) > before ? before : BigInt(discount);
          expect(left).toBe(before - taken);
          expect(after.every((entry) => entry.netPoisha >= 0n)).toBe(true);
          expect(after.map((entry) => entry.skuId)).toEqual(lines.map((entry) => entry.skuId));
        },
      ),
    );
  });
});
