/**
 * A product or category name into the slug shape the server's schema accepts:
 * `^[a-z0-9]+(-[a-z0-9]+)*$`.
 *
 * Its own module, with no imports, so the test can exercise it without pulling in
 * the API client — which reads the Vite environment at import time and therefore
 * cannot be loaded outside a built app.
 *
 * Bangla drops out rather than being transliterated. A guessed transliteration of
 * `লাল পাঞ্জাবি` is a web address nobody can predict, and an unpredictable address
 * is one that cannot be linked to. A name with no ASCII at all therefore falls back
 * to a timestamp-based slug: ugly and unique, which is the right trade against a 400
 * the operator cannot act on.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    // Strip the combining marks the decomposition left behind, so `é` becomes `e`.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? `c-${Date.now().toString(36)}` : slug.slice(0, 120);
}
