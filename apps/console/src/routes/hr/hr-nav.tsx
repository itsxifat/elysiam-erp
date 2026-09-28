import { Link } from '@tanstack/react-router';
import type { ComponentProps } from 'react';

import { useAbility } from '../../auth/session.js';
import { useHrT } from './messages.js';

/**
 * An HR path, as the router will know it.
 *
 * TanStack derives `to`'s type from the **live route tree**, so until the integrator wires
 * `hrRoutes()` into `router.tsx` these five paths are not in that union and every
 * `<Link to="/payroll">` in this module is a type error — in files this milestone owns, for a
 * reason that has nothing to do with this milestone. One named widening, in one place, which
 * the integrator deletes with the same commit that registers the routes.
 *
 * It cannot hide a wrong path for long: an unregistered path 404s the first time anybody
 * clicks it, and `routes.tsx` is the single list of what exists.
 */
export type HrPath = ComponentProps<typeof Link>['to'];

export const hrPath = (path: string): HrPath => path;

/**
 * The four HR screens, as tabs.
 *
 * They live in the page rather than in the sidebar because `NAVIGATION` is M05's file and is
 * edited concurrently by other milestones in this working tree — M19's INTEGRATION section
 * hands the integrator the child entries for it. Until then this is what makes attendance,
 * payroll and loans reachable, and it is worth keeping afterwards: a module with four screens
 * reads better with its own tab strip than with four sidebar entries at the same level as
 * Orders and Wallets.
 *
 * **The tabs are filtered by ability, not just hidden by the router.** People and attendance
 * need `read Employee`, which every role holds at least for themselves; payroll and loans
 * need `read Payroll`, which §6 gives hr, accounts and org_admin alone. A branch manager who
 * can see their branch's staff should not be shown a Payroll tab that answers 403 — that is
 * the permission-denied state being used as navigation.
 *
 * `activeProps` rather than a manual comparison against the current path: the router already
 * knows which one is active, and a hand-rolled check is the thing that goes stale when a path
 * changes.
 */
export function HrNav() {
  const t = useHrT();
  const ability = useAbility();
  const mayReadPayroll = ability.can('read', 'Payroll');

  const tab =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: `${tab} bg-muted font-medium text-foreground` };

  return (
    <nav aria-label={t('hr.people')} className="flex flex-wrap gap-1">
      <Link
        to={hrPath('/people')}
        className={tab}
        activeProps={active}
        activeOptions={{ exact: true }}
      >
        {t('hr.people')}
      </Link>
      <Link to={hrPath('/people/attendance')} className={tab} activeProps={active}>
        {t('hr.attendance')}
      </Link>
      {mayReadPayroll ? (
        <>
          <Link
            to={hrPath('/payroll')}
            className={tab}
            activeProps={active}
            activeOptions={{ exact: true }}
          >
            {t('hr.payroll')}
          </Link>
          <Link to={hrPath('/payroll/loans')} className={tab} activeProps={active}>
            {t('hr.loans')}
          </Link>
        </>
      ) : null}
    </nav>
  );
}

/** One labelled form control, the shape M07's and M09's forms use. */
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

/** The one input class the HR forms share, so density stays consistent (§24). */
export const control =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export const numericControl = `${control} tabular-nums text-right`;

/** Status tones, shared by the run list and the run detail so they cannot disagree. */
export const RUN_TONE: Readonly<
  Record<string, 'neutral' | 'warning' | 'success' | 'danger' | 'info'>
> = {
  draft: 'neutral',
  pending_approval: 'warning',
  posted: 'info',
  paid: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
};
