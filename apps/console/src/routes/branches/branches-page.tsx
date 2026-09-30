import { EmptyState, ErrorState, Money, PermissionGate, Skeleton, StatusBadge } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { listBranches } from './api.js';
import { useBranchesT } from './messages.js';

/**
 * Every branch the caller's role reaches, with today's till at a glance (D-014).
 *
 * The server scopes the list — a branch manager sees their own branches and
 * nothing else — and every figure is the server's: the screen adds nothing up.
 * Revenue only: cost and margin are on the branch's own dashboard, and only for
 * the roles that hold `read:cost`.
 */
export function BranchesPage() {
  const t = useBranchesT();
  const { locale } = useLocale();
  const ability = useAbility();
  const allowed = ability.can('read', 'LedgerReport');
  const branches = useQuery({
    queryKey: ['pos', 'branches'],
    queryFn: listBranches,
    enabled: allowed,
  });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{t('branches.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('branches.subtitle')}</p>
      </header>

      <PermissionGate
        allowed={allowed}
        explain={{ title: t('branches.deniedTitle'), detail: t('branches.deniedDetail') }}
      >
        {branches.isPending ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-row w-full" />
            <Skeleton className="h-row w-full" />
            <Skeleton className="h-row w-full" />
          </div>
        ) : branches.isError ? (
          <ErrorState title={t('branches.errorTitle')} />
        ) : branches.data.items.length === 0 ? (
          <EmptyState title={t('branches.emptyTitle')} detail={t('branches.emptyDetail')} />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="h-row px-3 text-left font-medium">{t('branches.colBranch')}</th>
                  <th className="h-row px-3 text-right font-medium">{t('branches.colSales')}</th>
                  <th className="h-row px-3 text-right font-medium">{t('branches.colNet')}</th>
                  <th className="h-row px-3 text-right font-medium">{t('branches.colRefunds')}</th>
                  <th className="h-row px-3 text-right font-medium">{t('branches.colShifts')}</th>
                  <th className="h-row px-3 text-right font-medium">{t('branches.colReviews')}</th>
                  <th className="h-row px-3 text-left font-medium">{t('branches.colDay')}</th>
                </tr>
              </thead>
              <tbody>
                {branches.data.items.map((branch) => (
                  <tr key={branch.id} className="border-t border-border hover:bg-accent">
                    <td className="h-row px-3">
                      <Link
                        to="/branches/$branchId"
                        params={{ branchId: branch.id }}
                        aria-label={`${t('branches.open')}: ${branch.name}`}
                        className="font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {branch.name}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {branch.code}
                      </span>
                    </td>
                    <td className="h-row px-3 text-right tabular-nums">{branch.salesCount}</td>
                    <td className="h-row px-3">
                      <Money poisha={branch.netSalesPoisha} locale={locale} />
                    </td>
                    <td className="h-row px-3">
                      <Money poisha={branch.refundsPoisha} locale={locale} />
                    </td>
                    <td className="h-row px-3 text-right tabular-nums">{branch.openShifts}</td>
                    <td className="h-row px-3 text-right tabular-nums">
                      {branch.openReviews > 0 ? (
                        <StatusBadge tone="warning">{branch.openReviews}</StatusBadge>
                      ) : (
                        branch.openReviews
                      )}
                    </td>
                    <td className="h-row px-3">
                      <StatusBadge tone={branch.closed ? 'success' : 'neutral'}>
                        {t(branch.closed ? 'branches.dayClosed' : 'branches.dayOpen')}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PermissionGate>
    </div>
  );
}
