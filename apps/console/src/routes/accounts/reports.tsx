import { Button, Label, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useId } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { listBranches } from '../branches/api.js';
import { listSuppliers } from '../supply/api.js';
import {
  AccountsHeader,
  AmountCell,
  Block,
  CostWithheld,
  DateInput,
  Empty,
  LoadFailed,
  LoadingRows,
  RangeBar,
} from './accounts-parts.js';
import { aging, balanceSheet, dhakaToday, profitAndLoss, type ReportLine } from './api.js';
import { useAccountsT, type AccountsMessageKey } from './messages.js';
import { asOfFrom, presetRange, rangeFrom } from './report-dates.js';
import type { ReportsSearch, ReportView } from './reports-search.js';

/**
 * The statements an owner reads (M08, §7): profit and loss over a range, the
 * balance sheet as of a date, and who owes whom by age.
 *
 * Every figure is the server's, from journal lines. Two honesty rules:
 *
 * - **Cost withheld is said, not hidden.** For a role without `read:cost` the P&L
 *   has no cost of sales, so its net is not gross profit, and the balance sheet
 *   does not balance by exactly the inventory it could not show. The screen says
 *   so and shows the difference rather than forcing the two sides equal.
 * - **The view, range, date and branch are in the URL**, so "the P&L for August at
 *   Gulshan" is a link somebody can send.
 */

const VIEWS: Record<ReportView, AccountsMessageKey> = {
  pnl: 'accounts.reports.pnl',
  balance: 'accounts.reports.balance',
  aging: 'accounts.reports.aging',
};

export function ReportsPage() {
  const a = useAccountsT();
  const ability = useAbility();
  const search = useSearch({ from: '/accounts/reports' });
  const navigate = useNavigate();
  const view: ReportView = search.view ?? 'pnl';
  const allowed = ability.can('read', 'LedgerReport');

  const go = (next: ReportsSearch) =>
    void navigate({ to: '/accounts/reports', search: { ...search, ...next }, replace: true });

  return (
    <div className="space-y-6">
      <AccountsHeader
        title={a('accounts.reports.title')}
        subtitle={a('accounts.reports.subtitle')}
      />
      <PermissionGate
        allowed={allowed}
        explain={{
          title: a('accounts.reports.deniedTitle'),
          detail: a('accounts.reports.deniedDetail'),
        }}
      >
        <div role="group" aria-label={a('accounts.reports.title')} className="flex flex-wrap gap-1">
          {(Object.keys(VIEWS) as ReportView[]).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={view === key ? 'primary' : 'outline'}
              aria-pressed={view === key}
              onClick={() => go({ view: key })}
            >
              {a(VIEWS[key])}
            </Button>
          ))}
        </div>
        {view === 'pnl' ? <ProfitAndLossView search={search} go={go} /> : null}
        {view === 'balance' ? <BalanceSheetView search={search} go={go} /> : null}
        {view === 'aging' ? <AgingView search={search} go={go} /> : null}
      </PermissionGate>
    </div>
  );
}

interface ViewProps {
  readonly search: ReportsSearch;
  readonly go: (next: ReportsSearch) => void;
}

/** A branch filter for org-wide roles; the server scopes a branch manager anyway. */
function BranchSelect({
  value,
  onChange,
}: {
  readonly value?: string;
  readonly onChange: (branch: string | undefined) => void;
}) {
  const a = useAccountsT();
  const id = useId();
  const branches = useQuery({ queryKey: ['pos', 'branches'], queryFn: listBranches });
  if ((branches.data?.items.length ?? 0) < 2) return null;
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="block">
        {a('accounts.reports.branch')}
      </Label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        className="h-control-sm rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <option value="">{a('accounts.reports.allBranches')}</option>
        {(branches.data?.items ?? []).map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function LineRows({ lines }: { readonly lines: readonly ReportLine[] }) {
  return (
    <>
      {lines.map((line) => (
        <tr key={line.accountId} className="border-b border-border">
          <td className="h-row px-4">
            <span className="mr-2 font-mono text-xs text-muted-foreground">{line.code}</span>
            {line.name}
          </td>
          <AmountCell poisha={line.amountPoisha} />
        </tr>
      ))}
    </>
  );
}

function SubtotalRow({
  label,
  poisha,
  strong = false,
}: {
  readonly label: string;
  readonly poisha: string;
  readonly strong?: boolean;
}) {
  const { locale } = useLocale();
  return (
    <tr
      className={`border-b border-border bg-muted/40 ${strong ? 'font-semibold' : 'font-medium'}`}
    >
      <td className="h-row px-4">{label}</td>
      <td className="h-row px-4 text-right">
        <Money poisha={poisha} locale={locale} />
      </td>
    </tr>
  );
}

function ProfitAndLossView({ search, go }: ViewProps) {
  const a = useAccountsT();
  const today = dhakaToday();
  const range = rangeFrom(search, today);
  const report = useQuery({
    queryKey: ['accounts', 'report', 'pnl', range.from, range.to, search.branch ?? 'all'],
    queryFn: () => profitAndLoss({ ...range, branchId: search.branch }),
  });

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <RangeBar
          from={range.from}
          to={range.to}
          today={today}
          onChange={(next) => go(next)}
          onPreset={(preset) => go(presetRange(preset, today))}
        />
        <BranchSelect value={search.branch} onChange={(branch) => go({ branch })} />
      </div>
      <Block title={a('accounts.reports.pnl')} caption={`${range.from} – ${range.to}`}>
        {report.isPending ? (
          <LoadingRows rows={6} />
        ) : report.isError ? (
          <LoadFailed onRetry={() => void report.refetch()} />
        ) : report.data.income.length === 0 && report.data.expense.length === 0 ? (
          <Empty label="accounts.reports.pnlEmpty" />
        ) : (
          <>
            <table className="w-full text-sm">
              <tbody>
                <SubtotalRow label={a('accounts.pnlIncome')} poisha={report.data.incomePoisha} />
                <LineRows lines={report.data.income} />
                <SubtotalRow label={a('accounts.pnlExpense')} poisha={report.data.expensePoisha} />
                <LineRows lines={report.data.expense} />
                <SubtotalRow label={a('accounts.pnlNet')} poisha={report.data.netPoisha} strong />
              </tbody>
            </table>
            <CostWithheld withheld={report.data.costWithheld} />
          </>
        )}
      </Block>
    </>
  );
}

function BalanceSheetView({ search, go }: ViewProps) {
  const a = useAccountsT();
  const { locale } = useLocale();
  const today = dhakaToday();
  const asOf = asOfFrom(search, today);
  const report = useQuery({
    queryKey: ['accounts', 'report', 'balance', asOf, search.branch ?? 'all'],
    queryFn: () => balanceSheet(asOf, search.branch),
  });

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <DateInput
          label={a('accounts.reports.asOf')}
          value={asOf}
          max={today}
          onChange={(value) => go({ asOf: value })}
        />
        <BranchSelect value={search.branch} onChange={(branch) => go({ branch })} />
      </div>
      {report.isPending ? (
        <Block title={a('accounts.reports.balance')}>
          <LoadingRows rows={6} />
        </Block>
      ) : report.isError ? (
        <Block title={a('accounts.reports.balance')}>
          <LoadFailed onRetry={() => void report.refetch()} />
        </Block>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Block title={a('accounts.reports.assets')} caption={asOf}>
            <table className="w-full text-sm">
              <tbody>
                <LineRows lines={report.data.assets} />
                <SubtotalRow
                  label={a('accounts.reports.totalAssets')}
                  poisha={report.data.assetsPoisha}
                  strong
                />
              </tbody>
            </table>
          </Block>
          <Block title={a('accounts.reports.funding')} caption={asOf}>
            <table className="w-full text-sm">
              <tbody>
                <SubtotalRow
                  label={a('accounts.reports.liabilities')}
                  poisha={report.data.liabilitiesPoisha}
                />
                <LineRows lines={report.data.liabilities} />
                <SubtotalRow
                  label={a('accounts.reports.equity')}
                  poisha={report.data.equityPoisha}
                />
                <LineRows lines={report.data.equity} />
                <SubtotalRow
                  label={a('accounts.reports.result')}
                  poisha={report.data.resultPoisha}
                />
              </tbody>
            </table>
            {report.data.differencePoisha === '0' ? (
              <p className="flex items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
                <StatusBadge tone="success">{a('accounts.reports.balanced')}</StatusBadge>
              </p>
            ) : (
              <p
                className="border-t border-border px-4 py-2 text-xs text-muted-foreground"
                role="note"
              >
                {a('accounts.reports.difference')}{' '}
                <Money poisha={report.data.differencePoisha} locale={locale} />
              </p>
            )}
            <CostWithheld withheld={report.data.costWithheld} />
          </Block>
        </div>
      )}
    </>
  );
}

const PARTY_LABELS: Record<string, AccountsMessageKey> = {
  supplier: 'accounts.party.supplier',
  courier: 'accounts.party.courier',
  reseller: 'accounts.party.reseller',
  investor: 'accounts.party.investor',
  employee: 'accounts.party.employee',
  lender: 'accounts.party.lender',
};

function AgingView({ search, go }: ViewProps) {
  const a = useAccountsT();
  const ability = useAbility();
  const today = dhakaToday();
  const asOf = asOfFrom(search, today);
  const side = search.side ?? 'payable';
  const report = useQuery({
    queryKey: ['accounts', 'report', 'aging', asOf, side],
    queryFn: () => aging(asOf, side),
  });
  // Names for the parties this screen can name; the rest show their kind and a short id.
  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', 'names'],
    queryFn: () => listSuppliers({ includeInactive: true }),
    enabled: ability.can('read', 'Supply'),
  });
  const names = new Map((suppliers.data?.items ?? []).map((row) => [row.id, row.name]));

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <DateInput
          label={a('accounts.reports.asOf')}
          value={asOf}
          max={today}
          onChange={(value) => go({ asOf: value })}
        />
        <div role="group" aria-label={a('accounts.reports.aging')} className="flex gap-1">
          {(['payable', 'receivable'] as const).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={side === key ? 'primary' : 'outline'}
              aria-pressed={side === key}
              onClick={() => go({ side: key })}
            >
              {a(key === 'payable' ? 'accounts.reports.payable' : 'accounts.reports.receivable')}
            </Button>
          ))}
        </div>
      </div>
      <Block title={a('accounts.reports.aging')} caption={a('accounts.reports.agingCaption')}>
        {report.isPending ? (
          <LoadingRows rows={4} />
        ) : report.isError ? (
          <LoadFailed onRetry={() => void report.refetch()} />
        ) : report.data.items.length === 0 ? (
          <Empty label="accounts.reports.agingEmpty" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="h-row px-4 text-left font-medium">
                    {a('accounts.reports.party')}
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    0–7
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    8–30
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    31–60
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    60+
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    {a('accounts.reports.total')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.data.items.map((item) => {
                  const kind = PARTY_LABELS[item.partyType];
                  return (
                    <tr
                      key={`${item.partyType}:${item.partyId}`}
                      className="border-b border-border"
                    >
                      <td className="h-row px-4">
                        {names.get(item.partyId) ?? (
                          <span className="font-mono text-xs">{item.partyId.slice(0, 8)}</span>
                        )}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {kind === undefined ? item.partyType : a(kind)}
                        </span>
                      </td>
                      <AmountCell poisha={item.bucket0to7Poisha} />
                      <AmountCell poisha={item.bucket8to30Poisha} />
                      <AmountCell poisha={item.bucket31to60Poisha} />
                      <AmountCell poisha={item.bucketOver60Poisha} />
                      <AmountCell poisha={item.totalPoisha} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {report.data === undefined ? null : <CostWithheld withheld={report.data.costWithheld} />}
      </Block>
    </>
  );
}
