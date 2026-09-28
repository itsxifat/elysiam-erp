import { Link } from '@tanstack/react-router';

import { DEFAULT_PAGE_SIZE } from '../../lib/table-search.js';
import { useStockT } from './messages.js';

/**
 * The four stock screens, as tabs.
 *
 * They live in the page rather than in the sidebar because `NAVIGATION` is M05's file
 * and is edited concurrently by other milestones in this working tree — M07's
 * INTEGRATION section hands the integrator the three child entries for it. Until then
 * this is what makes adjustments, transfers and counts reachable, and it is worth
 * keeping afterwards: a module with four screens reads better with its own tab strip
 * than with four sidebar entries at the same level as Orders and Wallets.
 *
 * `activeProps` rather than a manual comparison against the current path: the router
 * already knows which one is active, and a hand-rolled check is the thing that goes
 * stale when a path changes.
 */
export function StockNav() {
  const st = useStockT();
  const tab =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: `${tab} bg-muted font-medium text-foreground` };

  return (
    <nav aria-label={st('stock.title')} className="flex flex-wrap gap-1">
      {/* `/stock` validates its search, so a link to it has to name the first page.
          The other three carry no search params at all. */}
      <Link
        to="/stock"
        search={{ page: 1, pageSize: DEFAULT_PAGE_SIZE }}
        className={tab}
        activeProps={active}
        activeOptions={{ exact: true }}
      >
        {st('stock.levels')}
      </Link>
      <Link to="/stock/adjustments" className={tab} activeProps={active}>
        {st('stock.adjustments')}
      </Link>
      <Link to="/stock/transfers" className={tab} activeProps={active}>
        {st('stock.transfers')}
      </Link>
      <Link to="/stock/counts" className={tab} activeProps={active}>
        {st('stock.counts')}
      </Link>
    </nav>
  );
}
