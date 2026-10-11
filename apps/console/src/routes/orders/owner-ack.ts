/**
 * "I know somebody else is handling this order" (M41, D-710): `OWNER_ACK_HEADER` in
 * `@elysium/contracts`, spelled here so the overview's first download does not carry the
 * contracts' schemas for one string (a test keeps the two equal).
 */
export const OWNER_ACK = 'x-acknowledge-owner';

/** The acknowledgement on a desk write, sent only after the person said go ahead. */
export function ackHeaders(ack: boolean | undefined): Readonly<Record<string, string>> | undefined {
  return ack === true ? { [OWNER_ACK]: '1' } : undefined;
}
