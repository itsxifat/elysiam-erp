import type { TableSort } from '@elysium/ui';

/**
 * The demo dataset and a server-shaped query over it.
 *
 * Deterministic — a seeded linear congruential generator rather than
 * `Math.random()` — because a Playwright assertion about "the third row after
 * sorting by amount" has to mean the same thing on every run and on every
 * machine. A random fixture turns check 2 into a flaky test, and a flaky test on
 * the page that proves URL state works is worse than no test: it teaches everyone
 * to re-run it.
 *
 * `queryDemoRows` filters, sorts and slices in that order and returns a page plus
 * a total, which is the shape §23's offset-paginated endpoints have. Doing it here
 * rather than in the component is what keeps the DataTable honest: the component
 * never has more than one page of rows, so it cannot accidentally sort or filter
 * the page instead of the table.
 */

export interface DemoRow {
  readonly id: string;
  readonly reference: string;
  readonly channel: 'web' | 'showroom' | 'reseller';
  readonly status: 'open' | 'settled' | 'returned';
  /** Integer poisha as a string, exactly as it would cross the wire (§23). */
  readonly totalPoisha: string;
  readonly placedAt: string;
}

const CHANNELS: readonly DemoRow['channel'][] = ['web', 'showroom', 'reseller'];
const STATUSES: readonly DemoRow['status'][] = ['open', 'settled', 'returned'];

/** Numerical Recipes' LCG constants. Small, seeded, and enough for a fixture. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function build(): readonly DemoRow[] {
  const random = lcg(20_260_925);
  const rows: DemoRow[] = [];

  for (let index = 0; index < 137; index += 1) {
    const channel = CHANNELS[Math.floor(random() * CHANNELS.length)] ?? 'web';
    const status = STATUSES[Math.floor(random() * STATUSES.length)] ?? 'open';
    // Between ৳150 and ৳45,000, in poisha, always a whole number of poisha —
    // there is no such thing as a fractional poisha and a fixture that produced
    // one would be modelling something the system cannot store.
    const poisha = 15_000 + Math.floor(random() * 4_485_000);
    // Spread over the preceding weeks in UTC; the table renders them in Dhaka.
    const placedAt = new Date(Date.UTC(2026, 8, 25, 4, 0, 0) - index * 5_400_000).toISOString();

    rows.push({
      id: `demo-${String(index).padStart(3, '0')}`,
      reference: `ELY-${String(41_000 + index)}`,
      channel,
      status,
      totalPoisha: String(poisha),
      placedAt,
    });
  }

  return rows;
}

export const DEMO_ROWS: readonly DemoRow[] = build();

export interface DemoQuery {
  readonly query?: string | undefined;
  readonly status?: string | undefined;
  readonly sort: TableSort | null;
  readonly page: number;
  readonly pageSize: number;
}

export function queryDemoRows(input: DemoQuery): {
  readonly rows: readonly DemoRow[];
  readonly total: number;
} {
  let rows = DEMO_ROWS;

  if (input.query !== undefined) {
    const needle = input.query.toLowerCase();
    rows = rows.filter((row) => row.reference.toLowerCase().includes(needle));
  }
  if (input.status !== undefined) {
    rows = rows.filter((row) => row.status === input.status);
  }

  if (input.sort !== null) {
    const { columnId, direction } = input.sort;
    const sign = direction === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => sign * compare(a, b, columnId));
  }

  const start = (input.page - 1) * input.pageSize;
  return { rows: rows.slice(start, start + input.pageSize), total: rows.length };
}

function compare(a: DemoRow, b: DemoRow, columnId: string): number {
  if (columnId === 'totalPoisha') {
    /*
     * Compared as BigInt, not as numbers, and this is the point of the column
     * existing at all. A poisha amount at crore scale exceeds
     * `Number.MAX_SAFE_INTEGER`, so `Number(a) - Number(b)` sorts two distinct
     * amounts as equal — a sort that silently stops ordering the largest rows,
     * which are precisely the ones somebody sorted by amount to find.
     */
    const left = BigInt(a.totalPoisha);
    const right = BigInt(b.totalPoisha);
    return left === right ? 0 : left < right ? -1 : 1;
  }

  const left = String(a[columnId as keyof DemoRow] ?? '');
  const right = String(b[columnId as keyof DemoRow] ?? '');
  return left.localeCompare(right);
}
