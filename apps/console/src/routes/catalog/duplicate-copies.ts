/**
 * The duplicate dialogs' "copies" field (D-662, D-663), pure so the unit test loads it alone.
 *
 * Checked with the server's own limits (`DUPLICATE_LIMITS` in `@elysium/contracts`, which the
 * server's schemas are built from), so a dialog never offers a number the server refuses.
 */
import { DUPLICATE_LIMITS } from '@elysium/contracts';

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Why the copies field cannot be sent: out of 1 to 50, or too many new products in all. */
export type CopiesProblem = 'range' | 'tooMany';

/** A whole number of copies from the field (Bangla digits too), or null for anything else. */
export function parseCopies(text: string): number | null {
  const ascii = [...text.trim()]
    .map((character) => {
      const bangla = BANGLA_DIGITS.indexOf(character);
      return bangla === -1 ? character : String(bangla);
    })
    .join('');
  if (!/^\d{1,3}$/.test(ascii)) return null;
  const value = Number(ascii);
  return value >= DUPLICATE_LIMITS.copies.min && value <= DUPLICATE_LIMITS.copies.max
    ? value
    : null;
}

/**
 * What is wrong with `text` copies of each of `products` products, or null when it can be
 * sent: 1 to 50 copies, and at most 200 new products in all.
 */
export function copiesProblem(text: string, products: number): CopiesProblem | null {
  const copies = parseCopies(text);
  if (copies === null) return 'range';
  return copies * Math.max(products, 1) > DUPLICATE_LIMITS.total ? 'tooMany' : null;
}
