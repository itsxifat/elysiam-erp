/**
 * English only (D-750): the one check every document, SMS, email and receipt test asks.
 *
 * The owner's decision of 2026-10-11 is that the brands never wanted Bangla, so nothing the
 * system writes for a customer may carry a character of the Bengali block (U+0980 to U+09FF):
 * no Bangla letter, digit, vowel sign or the taka sign. Text a person typed (a buyer's name or
 * address) is theirs and is printed as typed; what this guards is the system's own words.
 */

/** Any character of the Bengali block, U+0980 to U+09FF. */
export const BANGLA_BLOCK = /[\u0980-\u09FF]/u;

/** The distinct Bengali-block characters in a text, in the order they first appear. */
export function banglaCharactersIn(text: string): string[] {
  const found: string[] = [];
  for (const character of text) {
    if (BANGLA_BLOCK.test(character) && !found.includes(character)) found.push(character);
  }
  return found;
}

/** Whether a text is free of the Bengali block. */
export function isFreeOfBangla(text: string): boolean {
  return !BANGLA_BLOCK.test(text);
}
