/**
 * What the console's Call buttons tell its phone (M47, D-843), in this tab only.
 *
 * Envo answers a Call by ringing the person's own phone first and dials the customer once it is
 * picked up. That ring-back shows the customer's number with the caller name `Envo call <number>`
 * (Envo's `envo-cc` dialplan). A ring-back from a number this tab has just asked to call, named
 * so, is the person's own call coming back to them, so the phone answers it at once instead of
 * showing it as a stranger's call. A real call from that customer in the same moment carries
 * the customer's own name, not Envo's, and rings as any call does. Kept for thirty seconds, then
 * forgotten; forgotten at once when the server refused the Call.
 */

const RING_BACK_MS = 30_000;

/** The caller name Envo gives its click-to-call ring-back (`CALLERID(name)=Envo call <to>`). */
const RING_BACK_NAME = 'Envo call ';

interface Expected {
  readonly national: string;
  readonly label: string;
  readonly at: number;
}

let expected: Expected | null = null;
const listeners = new Set<() => void>();

/** `+8801712345678`, `8801712345678` or `01712345678` as the eleven national digits. */
export function nationalDigits(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length === 13) return `0${digits.slice(3)}`;
  if (digits.length === 10 && digits.startsWith('1')) return `0${digits}`;
  return digits;
}

export function expectRingBack(phone: string, label: string): void {
  expected = { national: nationalDigits(phone), label, at: Date.now() };
  for (const listener of listeners) listener();
}

/** The server refused the Call: no ring-back is coming, so none is answered by itself. */
export function forgetRingBack(phone: string): void {
  if (expected?.national === nationalDigits(phone)) expected = null;
}

/**
 * The label of the ring-back this incoming call is, if it is one; it is used up. Both the number
 * and Envo's ring-back name must match.
 */
export function takeRingBack(
  phone: string,
  callerName: string,
  now: number = Date.now(),
): string | null {
  if (expected === null || now - expected.at > RING_BACK_MS) return null;
  if (nationalDigits(phone) !== expected.national) return null;
  if (!callerName.startsWith(RING_BACK_NAME)) return null;
  if (nationalDigits(callerName.slice(RING_BACK_NAME.length)) !== expected.national) return null;
  const label = expected.label;
  expected = null;
  return label;
}

export function onRingBackExpected(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A ringing card that names nobody asks who is calling again this often, for this long. */
const LOOKUP_AGAIN_MS = 2_000;
const LOOKUP_AGAIN_FOR_MS = 12_000;

/**
 * When the screen pop asks again (D-843): only for a ringing card that names nobody yet, in its
 * first seconds (Envo's `call.started` reaches the ERP a second or more after the phone rings).
 */
export function lookupAgainIn(
  card: { readonly kind: string; readonly at?: number } | null,
  customer: unknown,
  now: number,
): number | false {
  if (card?.kind !== 'incoming' || card.at === undefined || customer !== null) return false;
  return now - card.at < LOOKUP_AGAIN_FOR_MS ? LOOKUP_AGAIN_MS : false;
}
