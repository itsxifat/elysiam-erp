/**
 * The tab's title carries the unread count (M44a, D-766): `(3) Brand · Console`. The brand's
 * own title is set by `applyBrand`; this only adds or removes the leading count, so the two
 * never fight over the rest.
 */

const COUNT = /^\(\d+\+?\)\s/;

/** The title with `count` in front, or without one at zero. Pure, for the test. */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(COUNT, '');
  if (count <= 0) return base;
  return `(${count > 99 ? '99+' : String(count)}) ${base}`;
}

export function setTitleCount(count: number): void {
  if (typeof document === 'undefined') return;
  const next = titleWithCount(document.title, count);
  if (next !== document.title) document.title = next;
}
