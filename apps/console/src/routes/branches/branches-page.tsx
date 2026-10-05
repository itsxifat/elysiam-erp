import {
  Button,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  PermissionGate,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Settings2 } from 'lucide-react';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { listBranches } from './api.js';
import { useBranchesT } from './messages.js';
import '../../i18n/manage.js';
import { BranchManageDialog } from './branch-manage.js';

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
  // M39a (D-633): org_admin renames a branch or switches it off from here.
  const mayManage = ability.can('update', 'Branch');
  const [managing, setManaging] = useState<string | null>(null);
  const tm = useT();
  const queryClient = useQueryClient();
  const branches = useQuery({
    queryKey: ['pos', 'branches'],
    queryFn: listBranches,
    enabled: allowed,
  });

  return (
    <div className="space-y-5">
      <PageHeader title={t('branches.title')} description={t('branches.subtitle')} />

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
                  {mayManage ? (
                    <th className="h-row px-3">
                      <span className="sr-only">{tm('mg.branch.manage')}</span>
                    </th>
                  ) : null}
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
                      {branch.isActive === false ? (
                        <StatusBadge tone="neutral" className="ml-2">
                          {tm('mg.branch.inactive')}
                        </StatusBadge>
                      ) : null}
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
                    {mayManage ? (
                      <td className="h-row px-3 text-right">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tm('mg.branch.title').replace('{name}', branch.name)}
                          title={tm('mg.branch.manage')}
                          onClick={() => setManaging(branch.id)}
                        >
                          <Settings2 aria-hidden />
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PermissionGate>
      {managing === null ? null : (
        <BranchManageDialog
          key={managing}
          branchId={managing}
          onClose={() => setManaging(null)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ['pos', 'branches'] })}
        />
      )}
    </div>
  );
}
