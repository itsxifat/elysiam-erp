import { describe, expect, it } from 'vitest';

import { checkTransfer } from './transfer-form.js';

const FROM = '11111111-1111-4111-8111-111111111111';
const TO = '22222222-2222-4222-8222-222222222222';

function check(overrides: Partial<Parameters<typeof checkTransfer>[0]>) {
  return checkTransfer({
    fromWalletId: FROM,
    toWalletId: TO,
    amount: '1000',
    charge: '',
    ...overrides,
  });
}

describe('the transfer form', () => {
  it('sends taka as integer poisha, with a blank charge as zero', () => {
    expect(check({})).toEqual({ ok: true, amountPoisha: '100000', chargePoisha: '0' });
    expect(check({ amount: '12,500.50', charge: '10' })).toEqual({
      ok: true,
      amountPoisha: '1250050',
      chargePoisha: '1000',
    });
  });

  it('asks for both wallets before anything else', () => {
    expect(check({ fromWalletId: '' })).toEqual({
      ok: false,
      problem: 'accounts.transfer.pickBoth',
    });
    expect(check({ toWalletId: '', amount: 'nonsense' })).toEqual({
      ok: false,
      problem: 'accounts.transfer.pickBoth',
    });
  });

  it('refuses a transfer to the same wallet', () => {
    expect(check({ toWalletId: FROM })).toEqual({
      ok: false,
      problem: 'accounts.transfer.sameWallet',
    });
  });

  it.each([
    ['nothing', { amount: '' }],
    ['zero', { amount: '0' }],
    ['zero with paisa', { amount: '0.00' }],
    ['a negative amount', { amount: '-500' }],
    ['three decimals', { amount: '10.005' }],
    ['words', { amount: 'five hundred' }],
    ['a negative charge', { charge: '-10' }],
    ['an unreadable charge', { charge: 'ten' }],
  ])('refuses %s', (_label, overrides) => {
    expect(check(overrides)).toEqual({ ok: false, problem: 'accounts.transfer.amountInvalid' });
  });
});
