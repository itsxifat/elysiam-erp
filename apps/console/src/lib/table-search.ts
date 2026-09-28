import type { TableSort } from '@elysium/ui';
import { z } from 'zod';

/**
 * A DataTable's filters, sort and page, as URL search params (M05 check 2).
 *
 * The check is "filters persist in the URL across a reload", and the reason it is
 * a check at all is that the naive implementation — `useState` in the page
 * component — passes every manual test. You filter, you look, it works. What it
 * cannot do is the thing an order desk does twenty times a day: paste the address
 * into a chat and have the other person see the same rows. It also loses the
 * filter on every reload and makes the browser's Back button do nothing, which
 * users read as the application ignoring them.
 *
 * Keeping them in the URL fixes all three at once, and costs one thing: the
 * params are now a public interface, so they have to be *validated*. An
 * unvalidated `?page=-4` or `?page=1e400` reaches the API as a query parameter
 * and the resulting 400 or 500 looks like a server bug. So the schema below is
 * strict, coerces, clamps, and — importantly — **falls back rather than throws**:
 * a link somebody hand-edited should show the default view, not an error screen.
 *
 * `sort` is one string, `field:direction`, rather than two params. One param is
 * one thing to get wrong, and a `?sort=total&dir=` that lost its direction is a
 * state neither the table nor the server has an answer for.
 */

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * The search params every list screen shares.
 *
 * `catchall: true` on each field is what makes a hand-edited URL degrade to the
 * default rather than blow up. TanStack Router runs `validateSearch` before the
 * route renders, so a throw here is a whole-screen error boundary for a typo in
 * an address.
 */
export const tableSearchSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).catch(DEFAULT_PAGE_SIZE),
  /** `columnId:asc` or `columnId:desc`. Absent means the server's own order. */
  sort: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}:(asc|desc)$/)
    .optional()
    .catch(undefined),
  /** Free-text search. Trimmed, and an empty string is dropped entirely. */
  q: z
    .string()
    .max(200)
    .transform((value) => value.trim())
    .refine((value) => value !== '')
    .optional()
    .catch(undefined),
  status: z.string().max(64).optional().catch(undefined),
  type: z.string().max(64).optional().catch(undefined),
});

export type TableSearch = z.infer<typeof tableSearchSchema>;

/** The `sort` param as the DataTable wants it, or null when there is none. */
export function parseSort(sort: string | undefined): TableSort | null {
  if (sort === undefined) return null;
  const [columnId, direction] = sort.split(':');
  if (columnId === undefined || (direction !== 'asc' && direction !== 'desc')) return null;
  return { columnId, direction };
}

/** The DataTable's sort back to a param, or undefined so the key disappears. */
export function formatSort(sort: TableSort | null): string | undefined {
  return sort === null ? undefined : `${sort.columnId}:${sort.direction}`;
}

/**
 * Merge a change into the current search, dropping empty values.
 *
 * Empty values are *removed* rather than written as `?q=`, because a URL is
 * something people read and edit. `?status=&type=&q=` on every link is noise that
 * makes a shared address look broken, and `?status=` round-trips through the
 * schema as a validation failure rather than as "no filter".
 *
 * Any change to a filter or the sort resets the page to 1, and that is a
 * correctness matter rather than a convenience: page 4 of a filter that now
 * matches nine rows is an empty table, and the operator reads it as "the filter
 * found nothing" — which is a wrong answer, not a slow one.
 */
export function mergeSearch(current: TableSearch, patch: Partial<TableSearch>): TableSearch {
  const resetsPage = (['sort', 'q', 'status', 'type', 'pageSize'] as const).some(
    (key) => key in patch && patch[key] !== current[key],
  );

  const next: Record<string, unknown> = {
    ...current,
    ...patch,
    ...(resetsPage && patch.page === undefined ? { page: 1 } : {}),
  };

  /*
   * A cleared filter is *removed*, not written as `?status=`.
   *
   * A URL is something people read, edit and paste. `?status=&type=&q=` on every
   * link is noise that makes a shared address look broken, and an empty string
   * round-trips through the schema as a validation failure rather than as "no
   * filter" — so the link would show a different view from the one that was
   * shared.
   *
   * `page` and `pageSize` are deliberately *not* removed at their defaults. They
   * are always present in the result because the schema gives them defaults, which
   * is what lets every caller read `search.page` as a number instead of writing
   * `search.page ?? 1` at fifteen call sites — and one of those fifteen forgetting
   * is a page that silently reads as NaN.
   */
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === '') delete next[key];
  }

  return tableSearchSchema.parse(next);
}

/**
 * A page description for the DataTable from a keyset response.
 *
 * `total: null` on purpose for cursor-paginated endpoints (§23): they genuinely
 * cannot answer "how many pages" without a count that races the next insert, and
 * a fabricated total is worse than an absent one — a pager that says "of 12" and
 * then refuses page 12 is a bug report.
 */
export function keysetPage(search: TableSearch, hasNext: boolean) {
  return {
    page: search.page,
    pageSize: search.pageSize,
    total: null,
    hasNext,
  } as const;
}
