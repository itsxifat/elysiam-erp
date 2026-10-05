import {
  PageHeader,
  Skeleton,
  TabList,
  cn,
  controlClassName,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/catalog-pricing.js';
import { useSupplyT } from './messages.js';

/**
 * The four supply screens, as tabs.
 *
 * They live in the page rather than in the sidebar because `NAVIGATION` is M05's file and
 * is edited concurrently by other milestones in this working tree — M09's INTEGRATION
 * section hands the integrator the entries for it. Until then this is what makes entries,
 * returns and payments reachable, and it is worth keeping afterwards: a module with four
 * screens reads better with its own tab strip than with four sidebar entries at the same
 * level as Orders and Wallets.
 *
 * `activeProps` rather than a manual comparison against the current path: the router
 * already knows which one is active, and a hand-rolled check is the thing that goes stale
 * when a path changes. The look is the shared underline tabs (D-445).
 */
export function SupplyNav() {
  const st = useSupplyT();
  const t = useT();
  // Buying prices are purchase cost (M39b, D-638): the tab is there only for a cost role.
  const mayCost = useAbility().can('read', 'Cost');
  const tab = tabClassName;
  const active = { className: tabActiveClassName };

  return (
    <TabList label={st('supply.title')}>
      <Link to="/supply" className={tab} activeProps={active} activeOptions={{ exact: true }}>
        {st('supply.suppliers')}
      </Link>
      <Link to="/supply/entries" className={tab} activeProps={active}>
        {st('supply.entries')}
      </Link>
      <Link to="/supply/returns" className={tab} activeProps={active}>
        {st('supply.returns')}
      </Link>
      <Link to="/supply/payments" className={tab} activeProps={active}>
        {st('supply.payments')}
      </Link>
      {mayCost ? (
        <Link to="/supply/buying-prices" className={tab} activeProps={active}>
          {t('cp.costs.title')}
        </Link>
      ) : null}
    </TabList>
  );
}

/** A supply page's header: its title, one sentence, its action, and the section's tabs. */
export function SupplyHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly actions?: ReactNode;
  readonly eyebrow?: ReactNode;
}) {
  return (
    <PageHeader
      title={title}
      description={description}
      {...(actions === undefined ? {} : { actions })}
      {...(eyebrow === undefined ? {} : { eyebrow })}
      tabs={<SupplyNav />}
    />
  );
}

/** One labelled form control, the shape M07's stock forms use. */
export function Field({
  label,
  id,
  hint,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The one input class the supply forms share: the kit's control, as wide as its column. */
export const control = `${controlClassName} w-full disabled:opacity-50`;

export const numericControl = `${control} tabular-nums text-right`;

// --- tables ----------------------------------------------------------------------------

/** The kit DataTable's rhythm, for the supply screens' own tables (D-448). */
export const TH =
  'h-10 border-b border-border px-4 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground';
export const TH_NUMERIC = cn(TH, 'text-right');
export const TD = 'h-row border-b border-border px-4 align-middle';
export const TD_NUMERIC = cn(TD, 'text-right whitespace-nowrap tabular-nums');
export const TR =
  'motion-safe:duration-fast hover:bg-accent/60 motion-safe:transition-colors [&:last-child>td]:border-b-0';

/**
 * A table's frame: a hairline card that scrolls sideways on a narrow screen. While it
 * scrolls it is a labelled tab stop of its own (WCAG 2.1.1), because a read-only table has
 * nothing focusable for a keyboard user to scroll it with.
 */
export function TableFrame({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
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
      className={cn(
        'overflow-x-auto rounded-lg border border-border bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Rows shaped like the table they stand in for, while it loads. */
export function LoadingRows({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-4" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-6 w-full" />
      ))}
    </div>
  );
}
