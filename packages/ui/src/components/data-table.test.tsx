import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataTable, dataTableColumns, type DataTableColumn, type TableSort } from './data-table.js';

/**
 * The DataTable's contract with the screens that use it.
 *
 * The interesting assertions are about what it must *not* do. A table given one
 * page of a large result must not sort or filter that page — the library makes
 * both one option away, and the bug is invisible: a sorted page of 25 rows out of
 * 40,000 is sorting the wrong 25, and the operator reading it believes they are
 * looking at the largest orders.
 */

/*
 * Unmount between tests, explicitly.
 *
 * Testing Library auto-cleans only when vitest runs with `globals: true`, and this
 * repo does not — so without this, every `render` leaves its tree in the document
 * and `getByRole` starts finding two of everything. The symptom is a suite that
 * passes test by test and fails as a file, which is the most confusing way for a
 * test to be wrong.
 */
afterEach(cleanup);

interface Row {
  readonly id: string;
  readonly reference: string;
  readonly totalPoisha: string;
}

const ROWS: readonly Row[] = [
  { id: 'b', reference: 'ELY-002', totalPoisha: '2500' },
  { id: 'a', reference: 'ELY-001', totalPoisha: '99900' },
];

const column = dataTableColumns<Row>();
const COLUMNS = column.columns([
  column.accessor('reference', { header: 'Reference', meta: { sortable: true } }),
  column.accessor('totalPoisha', { header: 'Amount', meta: { numeric: true, sortable: true } }),
]) as readonly DataTableColumn<Row>[];

const LABELS = {
  columns: 'Columns',
  previous: 'Previous',
  next: 'Next',
  emptyTitle: 'Nothing to show',
  emptyDetail: 'No rows match the filters.',
  errorTitle: 'That list could not be loaded',
  errorDetail: 'Retrying is safe.',
  retry: 'Retry',
  pageStatus: 'Page 1',
  sortAscending: 'Sort ascending',
  sortDescending: 'Sort descending',
};

function renderTable(overrides: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  const onPageChange = vi.fn();
  const onSortChange = vi.fn();

  const result = render(
    <DataTable<Row>
      caption="Demo rows"
      columns={COLUMNS}
      data={ROWS}
      getRowId={(row) => row.id}
      page={{ page: 1, pageSize: 25, total: 2, hasNext: false }}
      onPageChange={onPageChange}
      sort={null}
      onSortChange={onSortChange}
      labels={LABELS}
      {...overrides}
    />,
  );

  return { ...result, onPageChange, onSortChange };
}

describe('the table renders the page it was given, in the order it was given', () => {
  it('does not reorder rows of its own accord', () => {
    // `ROWS` is deliberately out of order by reference. A client-side sorted row
    // model would silently fix that, and fixing it here means the server's order —
    // which for an inbox is "newest first" — has been thrown away.
    renderTable();
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells[0]).toBe('ELY-002');
  });

  it('marks numeric columns so they get tabular numerals and right alignment', () => {
    // `data-numeric` is what the base stylesheet keys on (check 9). Asserted on the
    // attribute rather than on a class, because the styling lives in CSS.
    const { container } = renderTable();
    expect(container.querySelectorAll('td[data-numeric]').length).toBe(2);
    expect(container.querySelectorAll('th[data-numeric]').length).toBe(1);
  });

  it('names the table for assistive technology', () => {
    renderTable();
    expect(screen.getByRole('table', { name: 'Demo rows' })).toBeDefined();
  });
});

describe('sorting is reported upward, never applied locally', () => {
  it('asks for ascending on the first click of an unsorted column', () => {
    const { onSortChange } = renderTable();
    screen.getAllByRole('button', { name: 'Sort ascending' })[0]?.click();
    expect(onSortChange).toHaveBeenCalledWith({ columnId: 'reference', direction: 'asc' });
  });

  it('asks for descending on the second', () => {
    const sort: TableSort = { columnId: 'reference', direction: 'asc' };
    const { onSortChange } = renderTable({ sort });
    screen.getByRole('button', { name: 'Sort descending' }).click();
    expect(onSortChange).toHaveBeenCalledWith({ columnId: 'reference', direction: 'desc' });
  });

  it('returns to unsorted on the third, so the server order is reachable', () => {
    // Without the third state there is no way back to the order the cursor is
    // stable in, and on a keyset-paginated list that matters for correctness.
    const sort: TableSort = { columnId: 'reference', direction: 'desc' };
    const { onSortChange } = renderTable({ sort });
    // The first sortable header: the second column is unsorted, so it carries the
    // same "Sort ascending" name.
    screen.getAllByRole('button', { name: 'Sort ascending' })[0]?.click();
    expect(onSortChange).toHaveBeenCalledWith(null);
  });

  it('announces the sorted column through aria-sort', () => {
    const sort: TableSort = { columnId: 'reference', direction: 'desc' };
    const { container } = renderTable({ sort });
    const headers = [...container.querySelectorAll('th')];
    expect(headers[0]?.getAttribute('aria-sort')).toBe('descending');
    expect(headers[1]?.getAttribute('aria-sort')).toBe('none');
  });
});

describe('every state §24 names is designed rather than left to happen', () => {
  it('shows a skeleton shaped like the rows, not a spinner', () => {
    const { container } = renderTable({ loading: true });
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('ELY-002')).toBeNull();
  });

  it('explains an empty result instead of showing a bare "no results"', () => {
    // An empty table with no explanation is indistinguishable from a broken filter.
    renderTable({ data: [] });
    expect(screen.getByText('Nothing to show')).toBeDefined();
    expect(screen.getByText('No rows match the filters.')).toBeDefined();
  });

  it('offers a retry on failure and never prints the error', () => {
    // An exception message routinely quotes the row that caused it; rendering it
    // would leak that row into whichever role happened to be looking (§23).
    const onRetry = vi.fn();
    renderTable({ error: new Error('relation "orders" does not exist'), onRetry });
    expect(screen.queryByText(/relation/)).toBeNull();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('pagination is the caller’s, and the pager cannot lie about it', () => {
  it('disables Previous on the first page', () => {
    renderTable();
    expect(
      screen.getByRole('button', { name: /Previous/ }).getAttribute('disabled'),
    ).not.toBeNull();
  });

  it('disables Next when the server said there is no next page', () => {
    renderTable();
    expect(screen.getByRole('button', { name: /Next/ }).getAttribute('disabled')).not.toBeNull();
  });

  it('asks for the next page by number', () => {
    const { onPageChange } = renderTable({
      page: { page: 2, pageSize: 25, total: null, hasNext: true },
    });
    screen.getByRole('button', { name: /Next/ }).click();
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
