import { describe, expect, it } from 'vitest';

import { attemptId } from './attempt.js';

/**
 * The client id a loan or a repayment is sent with (ledger audit W-C): a retry after a lost
 * response must reuse it, so the server answers from what the first request wrote instead
 * of recording a second loan and a second receipt.
 */
describe('attemptId', () => {
  it('sends a retry with the same values under the same id', () => {
    const attempt = { current: null };
    const values = { lenderId: 'a', principal: '1000', walletAccountId: 'w' };
    const first = attemptId(attempt, values);
    expect(attemptId(attempt, { ...values })).toBe(first);
  });

  it('starts a new attempt when anything is edited', () => {
    const attempt = { current: null };
    const first = attemptId(attempt, { instalmentId: 'i1', memo: '' });
    expect(attemptId(attempt, { instalmentId: 'i1', memo: 'cash' })).not.toBe(first);
    expect(attemptId(attempt, { instalmentId: 'i2', memo: 'cash' })).not.toBe(first);
  });

  it('starts a new attempt once the last one succeeded and was cleared', () => {
    const attempt: { current: { readonly key: string; readonly id: string } | null } = {
      current: null,
    };
    const values = { instalmentId: 'i1' };
    const first = attemptId(attempt, values);
    attempt.current = null;
    expect(attemptId(attempt, values)).not.toBe(first);
  });
});
