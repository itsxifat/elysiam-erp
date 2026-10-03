import {
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
  type CellData,
  type ColumnDef,
  type ColumnVisibilityState,
  type RowData,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from './button.js';
import { Checkbox } from './checkbox.js';
import { EmptyState, ErrorState, Skeleton } from './states.js';
import { cn } from '../lib/cn.js';

/**
 * The DataTable (§24, M05 checks 2 and 5).
 *
 * TanStack Table v9, headless, rendered entirely through our tokens — the
 * library contributes the column model, the header groups and the visibility
 * state, and not one pixel. That is the whole reason it is here rather than a
 * styled grid component (D-033): a library stylesheet cannot be re-themed per
 * org and cannot be kept in step between light and dark.
 *
 * Three design decisions carry most of the weight:
 *
 * **Pagination, sorting and filtering are the server's, and this component is
 * controlled.** It registers only `columnVisibilityFeature`, so there is no
 * client-side row model that could quietly sort or filter the *page* instead of
 * the table. That failure is nasty precisely because it looks right: a table of
 * 50 rows out of 40,000 that sorts itself is sorting the wrong 50, and the
 * operator reading it believes they are looking at the largest orders.
 *
 * **Filters, sort and page live in the URL, not in state.** The caller owns
 * them and hands them down. An order desk shares links — "look at this one" —
 * and a filter in component state produces a link to an unfiltered table. It
 * also means reload, back and forward all work without the component knowing
 * they exist.
 *
 * **Rows are 36px** (`h-row`, from `--row-height`), per `.claude/rules/frontend.md`.
 * Density comes from the type scale and the row height, not from cutting the
 * padding around the content region.
 *
 * Column visibility is the one piece of state kept locally, because it is a
 * per-viewer preference rather than a description of what is on screen: putting
 * it in the URL would mean a shared link imposed the sharer's hidden columns on
 * the reader.
 */

/**
 * The feature set. At module scope, and that is load-bearing — a fresh
 * `tableFeatures({})` per render invalidates every data-dependent model on
 * every render, which shows up as a table that rebuilds its columns while you
 * type in a filter.
 */
export interface DataTableColumnMeta {
  /**
   * A number, a money amount or a quantity.
   *
   * Not cosmetic: it sets `data-numeric`, which the base stylesheet turns into
   * tabular numerals and right alignment. That is how check 9's "every money
   * value uses tabular numerals" holds for a column whose author forgot about
   * it — the alignment is a property of the column's kind, declared once.
   */
  readonly numeric?: boolean;
  /** Offer a sort control. The sort itself is the server's (see above). */
  readonly sortable?: boolean;
  /**
   * The row's actions. Right-aligned, and on a device with a pointer they show when the
   * row is pointed at or focused, so a table of forty rows is not forty rows of buttons
   * (D-448). On touch they are always shown.
   */
  readonly actions?: boolean;
  /** Let a long value wrap instead of holding the row to one line. */
  readonly wrap?: boolean;
}

/**
 * The value that carries `DataTableColumnMeta` into v9's type-only `columnMeta`
 * slot. Empty at runtime; the library reads only its type.
 *
 * A typed constant rather than `{} as DataTableColumnMeta`, because the assertion
 * form is what `no-unnecessary-type-assertion` objects to — and silencing that rule
 * by deleting the annotation would make `columnDef.meta` infer as `{}`, so every
 * `meta: { numeric: true }` would become an excess-property error.
 */
const COLUMN_META_SHAPE: DataTableColumnMeta = {};

export const dataTableFeatures = tableFeatures({
  columnVisibilityFeature,
  // v9's type-only slot, rather than declaration-merging the global `ColumnMeta`:
  // merging would type every table in every app the same, and a module
  // augmentation in a library package leaks into consumers that never asked for
  // it.
  columnMeta: COLUMN_META_SHAPE,
});
export type DataTableFeatures = typeof dataTableFeatures;

/** A column definition for this table's feature set. */
export type DataTableColumn<TData extends RowData, TValue extends CellData = CellData> = ColumnDef<
  DataTableFeatures,
  TData,
  TValue
>;

/** The typed column builder, so a `accessorKey` typo is a compile error. */
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<DataTableFeatures, TData>();
}

export type SortDirection = 'asc' | 'desc';

export interface TableSort {
  readonly columnId: string;
  readonly direction: SortDirection;
}

/** One page of rows, as a server hands it over. */
export interface TablePage {
  /** 1-based, because that is what a URL says and what an operator reads. */
  readonly page: number;
  readonly pageSize: number;
  /**
   * The total row count, when the server knows it cheaply. `null` means "we do
   * not know", and the pager then offers Next based on `hasNext` alone rather
   * than inventing a page count — a keyset-paginated endpoint (§23) genuinely
   * cannot answer "how many pages", and a fabricated total is worse than none.
   */
  readonly total: number | null;
  readonly hasNext: boolean;
}

export interface DataTableLabels {
  readonly columns: string;
  readonly previous: string;
  readonly next: string;
  readonly emptyTitle: string;
  readonly emptyDetail?: string;
  readonly errorTitle: string;
  readonly errorDetail?: string;
  readonly retry: string;
  /** "Page 3", assembled by the caller so no translation template is needed. */
  readonly pageStatus: string;
  readonly sortAscending: string;
  readonly sortDescending: string;
}

export interface DataTableProps<TData extends RowData> {
  readonly columns: readonly DataTableColumn<TData>[];
  readonly data: readonly TData[];
  /** Stable row identity. Without it a re-fetch remounts every row. */
  readonly getRowId: (row: TData) => string;
  readonly page: TablePage;
  readonly onPageChange: (page: number) => void;
  /** Null when unsorted. A single sort, because that is what a URL reads well. */
  readonly sort: TableSort | null;
  readonly onSortChange: (sort: TableSort | null) => void;
  /** The filter controls, rendered in the toolbar beside column visibility. */
  readonly toolbar?: ReactNode;
  readonly loading?: boolean;
  /** Any truthy value renders the error state. Never rendered as text (§23). */
  readonly error?: unknown;
  readonly onRetry?: () => void;
  readonly labels: DataTableLabels;
  /** Accessible name for the table itself, e.g. "Approval requests". */
  readonly caption: string;
  readonly className?: string;
  /**
   * Columns hidden until the viewer asks for them (D-458): a table fits its page by
   * default, and the detail a few people want stays one click away under Columns.
   * Keyed by column id, `false` to hide.
   */
  readonly initialColumnVisibility?: Readonly<Record<string, boolean>>;
}

/** A frozen empty page, so a loading table does not remount its model. */
const NO_ROWS: readonly never[] = Object.freeze([]);

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  page,
  onPageChange,
  sort,
  onSortChange,
  toolbar,
  loading = false,
  error,
  onRetry,
  labels,
  caption,
  className,
  initialColumnVisibility,
}: DataTableProps<TData>) {
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>(() => ({
    ...initialColumnVisibility,
  }));
  const frame = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  /*
   * Whether more of the table sits past the right edge. When it does, the edge fades,
   * so a hidden column reads as "scroll for more" rather than as a cut-off value.
   */
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = () => {
      setClipped(element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);

  const table = useTable<DataTableFeatures, TData>({
    features: dataTableFeatures,
    // Widened from `readonly`: the option is mutable in the library's types, and
    // the props are readonly here so a screen cannot hand the table an array it
    // then mutates behind its back.
    columns: [...columns],
    data: loading ? NO_ROWS : [...data],
    getRowId: (row) => getRowId(row),
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
  });

  const columnCount = table.getVisibleLeafColumns().length;

  /**
   * Cycle asc → desc → unsorted.
   *
   * The third state matters: without it there is no way back to the server's
   * natural order, which for an approvals inbox is "newest first" — the order
   * the checker actually wants and the only one that makes the cursor stable.
   */
  function cycleSort(columnId: string) {
    if (sort?.columnId !== columnId) {
      onSortChange({ columnId, direction: 'asc' });
      return;
    }
    onSortChange(sort.direction === 'asc' ? { columnId, direction: 'desc' } : null);
  }

  if (error != null) {
    return (
      <ErrorState
        title={labels.errorTitle}
        {...(labels.errorDetail === undefined ? {} : { detail: labels.errorDetail })}
        {...(onRetry === undefined
          ? {}
          : {
              action: (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {labels.retry}
                </Button>
              ),
            })}
      />
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {toolbar === undefined ? null : (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          <ColumnVisibilityMenu table={table} label={labels.columns} />
        </div>
      )}

      {/*
       * The table scrolls inside its own frame on a wide screen, so its header can stick
       * while the rows move and the pager below stays in reach (D-448). On a phone the
       * page scrolls instead: two nested scroll areas on a small screen are a trap.
       */}
      <div
        ref={frame}
        data-clipped={clipped ? 'end' : undefined}
        className="overflow-auto rounded-lg border border-border bg-card data-[clipped=end]:fade-x-end md:max-h-[calc(100dvh-14rem)]"
      >
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const sortable = meta?.sortable === true;
                  const numeric = meta?.numeric === true;
                  const active = sort?.columnId === header.column.id ? sort : null;

                  return (
                    <th
                      key={header.id}
                      scope="col"
                      {...(numeric ? { 'data-numeric': '' } : {})}
                      aria-sort={
                        !sortable
                          ? undefined
                          : active === null
                            ? 'none'
                            : active.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                      }
                      className={cn(
                        'sticky top-0 z-10 h-10 border-b border-border bg-card px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4',
                        numeric && 'text-right',
                        meta?.actions === true && 'text-right',
                      )}
                    >
                      {header.isPlaceholder ? null : sortable ? (
                        // Named by the column it sorts, then the action: an
                        // `aria-label` of the action alone replaced the visible
                        // header, so a screen reader announced "Sort ascending"
                        // for every column alike (WCAG 2.5.3, label in name).
                        // The current direction is the header's `aria-sort`.
                        <button
                          type="button"
                          onClick={() => cycleSort(header.column.id)}
                          className={cn(
                            'group/sort -mx-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs font-medium',
                            active === null ? 'text-muted-foreground' : 'text-foreground',
                            'motion-safe:duration-fast hover:text-foreground motion-safe:transition-colors',
                            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                          )}
                        >
                          <table.FlexRender header={header} />
                          <span className="sr-only">
                            {`(${
                              active?.direction === 'asc'
                                ? labels.sortDescending
                                : labels.sortAscending
                            })`}
                          </span>
                          {active === null ? (
                            <ArrowUpDown
                              aria-hidden="true"
                              className="size-3 opacity-40 group-hover/sort:opacity-80"
                            />
                          ) : active.direction === 'asc' ? (
                            <ArrowUp aria-hidden="true" className="size-3" />
                          ) : (
                            <ArrowDown aria-hidden="true" className="size-3" />
                          )}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {loading ? (
              /* A skeleton shaped like the rows it replaces (§24), so nothing
                 jumps when the page lands. A centred spinner over a table both
                 hides the headers and guarantees a reflow. */
              Array.from({ length: Math.min(page.pageSize, 8) }, (_, index) => (
                <tr key={index}>
                  {Array.from({ length: Math.max(columnCount, 1) }, (__, cell) => (
                    <td
                      key={cell}
                      className="h-row border-b border-border px-3 align-middle first:pl-4 last:pr-4"
                    >
                      <Skeleton
                        className={cn(
                          'h-3',
                          cell === 0 ? 'w-20' : cell % 3 === 1 ? 'w-28' : 'w-16',
                        )}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={Math.max(columnCount, 1)} className="p-0">
                  <EmptyState
                    title={labels.emptyTitle}
                    {...(labels.emptyDetail === undefined ? {} : { detail: labels.emptyDetail })}
                    className="rounded-none border-0"
                  />
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="group/row motion-safe:duration-fast hover:bg-accent/60 motion-safe:transition-colors [&:last-child>td]:border-b-0"
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta;
                    return (
                      <td
                        key={cell.id}
                        {...(meta?.numeric === true ? { 'data-numeric': '' } : {})}
                        className={cn(
                          'h-row border-b border-border px-3 align-middle text-foreground first:pl-4 last:pr-4',
                          meta?.wrap === true ? 'py-2' : 'whitespace-nowrap',
                          meta?.actions === true &&
                            'text-right [@media(hover:hover)]:[&>*]:opacity-0 [@media(hover:hover)]:group-focus-within/row:[&>*]:opacity-100 [@media(hover:hover)]:group-hover/row:[&>*]:opacity-100',
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground tabular-nums" role="status">
            {labels.pageStatus}
          </p>
          {/* With no toolbar above, the column choice sits down here rather than alone on
              a row of its own. */}
          {toolbar === undefined ? (
            <ColumnVisibilityMenu table={table} label={labels.columns} placement="top" />
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={page.page <= 1 || loading}
            onClick={() => onPageChange(page.page - 1)}
          >
            <ChevronLeft aria-hidden="true" />
            {labels.previous}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!page.hasNext || loading}
            onClick={() => onPageChange(page.page + 1)}
          >
            {labels.next}
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Column visibility, as a plain disclosure rather than a dropdown menu.
 *
 * A checkbox list inside a `<details>`-style popover is keyboard-reachable by
 * construction: Tab reaches the toggle, Tab reaches each checkbox, Escape is
 * handled by the caller's focus. A Radix dropdown would also work, but its menu
 * semantics announce checkboxes as menu items, and a menu that stays open while
 * you tick four boxes is not what a menu role describes.
 */
function ColumnVisibilityMenu<TData extends RowData>({
  table,
  label,
  placement = 'bottom',
}: {
  readonly table: ReturnType<typeof useTable<DataTableFeatures, TData>>;
  readonly label: string;
  readonly placement?: 'bottom' | 'top';
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
        className="text-muted-foreground"
      >
        <Columns3 aria-hidden="true" />
        {label}
      </Button>

      {open ? (
        <div
          role="group"
          aria-label={label}
          className={cn(
            'absolute z-30 min-w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-popover motion-safe:animate-in',
            placement === 'bottom' ? 'right-0 mt-1.5' : 'bottom-full left-0 mb-1.5',
          )}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          {table.getAllLeafColumns().map((column) => (
            <label
              key={column.id}
              className="flex h-control-sm cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Checkbox
                checked={column.getIsVisible()}
                onCheckedChange={() => column.toggleVisibility()}
              />
              {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
