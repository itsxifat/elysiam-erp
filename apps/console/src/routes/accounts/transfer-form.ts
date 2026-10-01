import { takaToPoisha } from '@elysium/ui';

/**
 * What the transfer form sends, or why it cannot be sent yet (M08).
 *
 * Pure, so the rules can be tested without a browser: both wallets chosen, two
 * different wallets, and an amount above zero in taka with at most two decimals.
 * A blank bank charge is zero; anything else must parse. The server checks every
 * one of these again — this is what saves the round trip and says which field is
 * wrong.
 */

export type TransferProblem =
  'accounts.transfer.pickBoth' | 'accounts.transfer.sameWallet' | 'accounts.transfer.amountInvalid';

export type TransferCheck =
  | { readonly ok: true; readonly amountPoisha: string; readonly chargePoisha: string }
  | { readonly ok: false; readonly problem: TransferProblem };

export function checkTransfer(input: {
  readonly fromWalletId: string;
  readonly toWalletId: string;
  readonly amount: string;
  readonly charge: string;
}): TransferCheck {
  if (input.fromWalletId === '' || input.toWalletId === '') {
    return { ok: false, problem: 'accounts.transfer.pickBoth' };
  }
  if (input.fromWalletId === input.toWalletId) {
    return { ok: false, problem: 'accounts.transfer.sameWallet' };
  }
  const amountPoisha = takaToPoisha(input.amount);
  const chargePoisha = input.charge.trim() === '' ? '0' : takaToPoisha(input.charge);
  // `takaToPoisha` reads a sign, because other fields take one; neither of these
  // may. A negative transfer is the reverse transfer, entered the other way round.
  if (
    amountPoisha === null ||
    amountPoisha === '0' ||
    amountPoisha.startsWith('-') ||
    chargePoisha === null ||
    chargePoisha.startsWith('-')
  ) {
    return { ok: false, problem: 'accounts.transfer.amountInvalid' };
  }
  return { ok: true, amountPoisha, chargePoisha };
}
