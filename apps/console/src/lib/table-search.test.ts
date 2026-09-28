import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  formatSort,
  mergeSearch,
  parseSort,
  tableSearchSchema,
} from './table-search.js';

/**
 * M05 acceptance check 2, in the layer that decides it.
 *
 * The browser half — "filters persist in the URL across a reload" — is the
 * integrator's Playwright run. What can go wrong *below* it is this module, and the
 * failures are quiet: a page that does not reset when a filter changes shows an
 * empty table and reads as "no matches"; a param that throws instead of falling
 * back turns a mistyped address into an error screen.
 */

describe('search params survive being a public interface', () => {
  it('defaults an absent search to page 1 at the default size', () => {
    const parsed = tableSearchSchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('coerces the strings a URL actually carries', () => {
    // Search params are always strings. A schema built with `z.number()` rejects
    // every real URL, and the symptom is "the pager does nothing".
    expect(tableSearchSchema.parse({ page: '3', pageSize: '50' })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
  });

  it('falls back rather than throwing on a hand-edited page', () => {
    // A negative page reaching the API is a 400 that looks like a server bug.
    expect(tableSearchSchema.parse({ page: '-4' }).page).toBe(1);
    expect(tableSearchSchema.parse({ page: 'seventeen' }).page).toBe(1);
  });

  it('clamps an absurd page size instead of asking the server for it', () => {
    // `?pageSize=100000` is either a typo or somebody probing for a way to make
    // the API allocate. Either way the answer is the maximum, not the request.
    expect(tableSearchSchema.parse({ pageSize: '100000' }).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('drops a sort it cannot interpret', () => {
    expect(tableSearchSchema.parse({ sort: 'total:sideways' }).sort).toBeUndefined();
    expect(tableSearchSchema.parse({ sort: 'total:desc' }).sort).toBe('total:desc');
  });

  it('treats a blank query as no query at all', () => {
    // `?q=` round-tripping as an empty-string filter is how a list returns
    // nothing and nobody can see why.
    expect(tableSearchSchema.parse({ q: '   ' }).q).toBeUndefined();
  });
});

describe('sort round-trips between the URL and the table', () => {
  it('parses a direction pair', () => {
    expect(parseSort('totalPoisha:desc')).toStrictEqual({
      columnId: 'totalPoisha',
      direction: 'desc',
    });
  });

  it('formats back to the same string', () => {
    expect(formatSort({ columnId: 'reference', direction: 'asc' })).toBe('reference:asc');
  });

  it('maps the unsorted state to an absent param, not to an empty one', () => {
    expect(formatSort(null)).toBeUndefined();
    expect(parseSort(undefined)).toBeNull();
  });
});

describe('merging a change keeps the address honest', () => {
  const base = tableSearchSchema.parse({ page: '4', status: 'pending' });

  it('resets to page 1 when a filter changes', () => {
    /*
     * The failure this prevents is a wrong answer rather than a slow one: page 4
     * of a filter that now matches nine rows is an empty table, and the operator
     * reads it as "the filter found nothing".
     */
    expect(mergeSearch(base, { status: 'approved' }).page).toBe(1);
  });

  it('resets to page 1 when the sort changes', () => {
    expect(mergeSearch(base, { sort: 'amountPoisha:desc' }).page).toBe(1);
  });

  it('does not reset the page when only the page changed', () => {
    expect(mergeSearch(base, { page: 5 }).page).toBe(5);
  });

  it('does not reset the page when a filter is set to the value it already had', () => {
    // Re-selecting the current filter should not throw the reader back to the
    // first page; nothing about what they are looking at has changed.
    expect(mergeSearch(base, { status: 'pending' }).page).toBe(4);
  });

  it('removes a cleared filter instead of writing it as empty', () => {
    const next = mergeSearch(base, { status: undefined });
    expect(next.status).toBeUndefined();
    expect(Object.keys(next)).not.toContain('status');
  });

  it('always resolves page and pageSize to numbers, so no caller needs a fallback', () => {
    // The alternative is `search.page ?? 1` at every call site, and the one that
    // forgets is a pager that asks the API for page NaN.
    const next = mergeSearch(base, { page: 1 });
    expect(next.page).toBe(1);
    expect(next.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('carries every other filter through untouched', () => {
    const wide = tableSearchSchema.parse({ status: 'pending', type: 'payment', q: 'ELY' });
    expect(mergeSearch(wide, { sort: 'reference:asc' })).toMatchObject({
      status: 'pending',
      type: 'payment',
      q: 'ELY',
      sort: 'reference:asc',
    });
  });
});
