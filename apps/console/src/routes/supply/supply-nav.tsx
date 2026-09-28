import { Link } from '@tanstack/react-router';

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
 * when a path changes.
 */
export function SupplyNav() {
  const st = useSupplyT();
  const tab =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: `${tab} bg-muted font-medium text-foreground` };

  return (
    <nav aria-label={st('supply.title')} className="flex flex-wrap gap-1">
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
    </nav>
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
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The one input class the supply forms share, so density stays consistent. */
export const control =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export const numericControl = `${control} tabular-nums text-right`;
