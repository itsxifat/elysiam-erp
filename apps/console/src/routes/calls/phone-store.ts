/**
 * What the console's Call buttons tell its phone (M47, D-843), in this tab only.
 *
 * Envo answers a Call by ringing the person's own phone first, showing the customer's number,
 * and dials the customer once it is picked up. A ring-back from a number this tab has just asked
 * to call is the person's own call coming back to them, so the phone answers it at once instead
 * of showing it as a stranger's call. Kept for thirty seconds, then forgotten.
 */

const RING_BACK_MS = 30_000;

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

/** The label of the ring-back this number is, if it is one; it is used up. */
export function takeRingBack(phone: string, now: number = Date.now()): string | null {
  if (expected === null || now - expected.at > RING_BACK_MS) return null;
  if (nationalDigits(phone) !== expected.national) return null;
  const label = expected.label;
  expected = null;
  return label;
}

export function onRingBackExpected(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
