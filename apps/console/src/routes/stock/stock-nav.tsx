import {
  PageHeader,
  TabList,
  cn,
  controlClassName,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
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
 * stale when a path changes. The look is the kit's underline tab (D-445).
 */
export function StockNav() {
  const st = useStockT();
  const t = useT();
  const tab = tabClassName;
  const active = { className: tabActiveClassName };

  return (
    <TabList label={st('stock.title')}>
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
      <Link to="/stock/in-hand" className={tab} activeProps={active}>
        {t('st.inHand.tab')}
      </Link>
    </TabList>
  );
}

/** A stock screen's header: its title, one sentence, the primary action, the tabs. */
export function StockHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
}) {
  return (
    <PageHeader
      title={title}
      description={description}
      {...(actions === undefined ? {} : { actions })}
      tabs={<StockNav />}
    />
  );
}

/** The kit's field chrome, full width, for the stock forms. */
export const control = cn(controlClassName, 'w-full disabled:opacity-50');

/** One labelled form control. */
export function Field({
  label,
  id,
  hint,
  children,
  className,
}: {
  readonly label: string;
  readonly id: string;
  readonly hint?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/*
 * The DataTable's look for the stock screens' own tables (D-448): small muted headers,
 * 40px rows, hairlines between rows and none under the last, numbers to the right.
 */
export const TH =
  'h-10 border-b border-border px-4 text-left text-xs font-medium whitespace-nowrap text-muted-foreground';
export const TH_NUM = cn(TH, 'text-right');
export const TD = 'h-row border-b border-border px-4 align-middle whitespace-nowrap';
export const TD_NUM = cn(TD, 'text-right tabular-nums');
export const TR = 'motion-safe:transition-colors hover:bg-accent/60 [&:last-child>td]:border-b-0';

/**
 * A table's card frame. While it scrolls sideways it is a labelled region with a tab
 * stop (WCAG 2.1.1): a read-only table has nothing focusable a keyboard user could
 * scroll it with.
 */
export function TableFrame({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = () => setScrollable(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild !== null) observer?.observe(element.firstElementChild);
    return () => observer?.disconnect();
  }, []);
  return (
    <div
      ref={frame}
      {...(scrollable ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})}
      className="overflow-x-auto rounded-lg border border-border bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </div>
  );
}
