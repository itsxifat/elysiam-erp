import { Money, PermissionGate } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { useSession } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  AccountsHeader,
  AmountCell,
  Block,
  Empty,
  LoadFailed,
  LoadingRows,
  RangeBar,
} from './accounts-parts.js';
import { consolidatedProfitAndLoss, consolidatedWallets, dhakaToday } from './api.js';
import { useAccountsT } from './messages.js';
import { presetRange, rangeFrom } from './report-dates.js';

/**
 * All five brands side by side, for Super Admin only (M08 check 3, §5 exception 3).
 *
 * Read through the analytics role, which can read three ledger tables and write
 * nothing. The group totals are the server's, computed from the same rows as the
 * brand lines, so they always equal the sum of what is shown.
 */
export function ConsolidatedPage() {
  const a = useAccountsT();
  const { locale } = useLocale();
  const session = useSession();
  const search = useSearch({ from: '/accounts/consolidated' });
  const navigate = useNavigate();
  const today = dhakaToday();
  const range = rangeFrom(search, today);
  const allowed = session.context?.isSuperAdmin === true;

  const wallets = useQuery({
    queryKey: ['accounts', 'consolidated', 'wallets'],
    queryFn: consolidatedWallets,
    enabled: allowed,
  });
  const pnl = useQuery({
    queryKey: ['accounts', 'consolidated', 'pnl', range.from, range.to],
    queryFn: () => consolidatedProfitAndLoss(range),
    enabled: allowed,
  });

  const go = (next: { from: string; to: string }) =>
    void navigate({ to: '/accounts/consolidated', search: next, replace: true });

  return (
    <div className="space-y-6">
      <AccountsHeader
        title={a('accounts.consolidated.title')}
        subtitle={a('accounts.consolidated.subtitle')}
      />
      <PermissionGate
        allowed={allowed}
        explain={{
          title: a('accounts.consolidated.deniedTitle'),
          detail: a('accounts.consolidated.deniedDetail'),
        }}
      >
        <Block title={a('accounts.consolidated.wallets')}>
          {wallets.isPending ? (
            <LoadingRows />
          ) : wallets.isError ? (
            <LoadFailed onRetry={() => void wallets.refetch()} />
          ) : wallets.data.orgs.length === 0 ? (
            <Empty label="accounts.consolidated.empty" />
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {wallets.data.orgs.map((org) => (
                  <tr key={org.orgId} className="border-b border-border">
                    <td className="h-row px-4">{org.orgName}</td>
                    <AmountCell poisha={org.totalPoisha} />
                  </tr>
                ))}
                <tr className="bg-muted/40 font-semibold">
                  <td className="h-row px-4">{a('accounts.consolidated.group')}</td>
                  <td className="h-row px-4 text-right">
                    <Money poisha={wallets.data.totalPoisha} locale={locale} />
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </Block>

        <RangeBar
          from={range.from}
          to={range.to}
          today={today}
          onChange={go}
          onPreset={(preset) => go(presetRange(preset, today))}
        />
        <Block title={a('accounts.consolidated.pnl')} caption={`${range.from} – ${range.to}`}>
          {pnl.isPending ? (
            <LoadingRows />
          ) : pnl.isError ? (
            <LoadFailed onRetry={() => void pnl.refetch()} />
          ) : pnl.data.orgs.length === 0 ? (
            <Empty label="accounts.consolidated.empty" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th scope="col" className="h-row px-4 text-left font-medium">
                      {a('accounts.consolidated.brand')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {a('accounts.pnlIncome')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {a('accounts.pnlExpense')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {a('accounts.pnlNet')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.data.orgs.map((org) => (
                    <tr key={org.orgId} className="border-b border-border">
                      <td className="h-row px-4">{org.orgName}</td>
                      <AmountCell poisha={org.incomePoisha} />
                      <AmountCell poisha={org.expensePoisha} />
                      <AmountCell poisha={org.netPoisha} />
                    </tr>
                  ))}
                  <tr className="bg-muted/40 font-semibold">
                    <td className="h-row px-4">{a('accounts.consolidated.group')}</td>
                    <AmountCell poisha={pnl.data.incomePoisha} />
                    <AmountCell poisha={pnl.data.expensePoisha} />
                    <AmountCell poisha={pnl.data.netPoisha} />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Block>
      </PermissionGate>
    </div>
  );
}
