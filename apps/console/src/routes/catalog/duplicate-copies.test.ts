import { DUPLICATE_LIMITS, duplicateCopiesSchema } from '@elysium/contracts';
import { describe, expect, it } from 'vitest';

import { copiesProblem, parseCopies } from './duplicate-copies.js';

/** The duplicate dialogs' copies field (D-662, D-663), checked with the server's own limits. */
describe('parseCopies', () => {
  it('reads a whole number from 1 to 50, Bangla digits too', () => {
    expect(parseCopies('1')).toBe(1);
    expect(parseCopies(' 3 ')).toBe(3);
    expect(parseCopies('50')).toBe(50);
    expect(parseCopies('০৩')).toBe(3);
    expect(parseCopies('২০')).toBe(20);
  });

  it('refuses blanks, zero, fractions, signs, words and anything over 50', () => {
    for (const text of ['', ' ', '0', '51', '100', '2.5', '-1', '+2', '1e1', 'three', '১০০']) {
      expect(parseCopies(text)).toBeNull();
    }
  });

  it('accepts exactly what the server schema accepts', () => {
    for (let copies = -2; copies <= 60; copies += 1) {
      expect(parseCopies(String(copies)) !== null).toBe(
        duplicateCopiesSchema.safeParse(copies).success,
      );
    }
  });
});

describe('copiesProblem', () => {
  it('is null for a number the server takes', () => {
    expect(copiesProblem('1', 1)).toBeNull();
    expect(copiesProblem('50', 1)).toBeNull();
    expect(copiesProblem('2', 100)).toBeNull();
  });

  it('says the range for anything that is not 1 to 50', () => {
    expect(copiesProblem('', 1)).toBe('range');
    expect(copiesProblem('0', 3)).toBe('range');
    expect(copiesProblem('51', 1)).toBe('range');
  });

  it('says too many past 200 new products in all, as the server refuses', () => {
    expect(DUPLICATE_LIMITS.total).toBe(200);
    expect(copiesProblem('3', 67)).toBe('tooMany');
    expect(copiesProblem('50', 5)).toBe('tooMany');
    expect(copiesProblem('50', 4)).toBeNull();
    expect(copiesProblem('2', 100)).toBeNull();
  });
});
