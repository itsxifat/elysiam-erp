import { Button, Label, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
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
  StatementTable,
  useSourceLabel,
} from './accounts-parts.js';
import { accountLedger, dayBook, dhakaToday, ledgerAccounts, trialBalance } from './api.js';
import { useAccountsT, type AccountsMessageKey } from './messages.js';
import { asOfFrom, presetRange, rangeFrom } from './report-dates.js';
import type { LedgerSearch, LedgerView } from './ledger-search.js';

/**
 * The books themselves (M03's reports): the trial balance, the day book, and one
 * account's ledger.
 *
 * These are what an accountant checks the statements against. The trial balance
 * shows its difference rather than assuming it is zero: it is zero whenever the
 * books are whole, and a screen that hid a non-zero figure would be the one place
 * nobody would see it. A trial-balance row opens that account's ledger.
 */

const VIEWS: Record<LedgerView, AccountsMessageKey> = {
  trial: 'accounts.ledger.trial',
  daybook: 'accounts.ledger.daybook',
  account: 'accounts.ledger.account',
};

export function LedgerPage() {
  const a = useAccountsT();
  const ability = useAbility();
  const search = useSearch({ from: '/accounts/ledger' });
  const navigate = useNavigate();
  const view: LedgerView = search.view ?? 'trial';

  const go = (next: LedgerSearch) =>
    void navigate({ to: '/accounts/ledger', search: { ...search, ...next }, replace: true });

  return (
    <div className="space-y-6">
      <AccountsHeader title={a('accounts.ledger.title')} subtitle={a('accounts.ledger.subtitle')} />
      <PermissionGate
        allowed={ability.can('read', 'LedgerReport')}
        explain={{
          title: a('accounts.reports.deniedTitle'),
          detail: a('accounts.reports.deniedDetail'),
        }}
      >
        <div role="group" aria-label={a('accounts.ledger.title')} className="flex flex-wrap gap-1">
          {(Object.keys(VIEWS) as LedgerView[]).map((key) => (
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
        {view === 'trial' ? <TrialBalanceView search={search} go={go} /> : null}
        {view === 'daybook' ? <DayBookView search={search} go={go} /> : null}
        {view === 'account' ? <AccountView search={search} go={go} /> : null}
      </PermissionGate>
    </div>
  );
}

interface ViewProps {
  readonly search: LedgerSearch;
  readonly go: (next: LedgerSearch) => void;
}

function TrialBalanceView({ search, go }: ViewProps) {
  const a = useAccountsT();
  const { locale } = useLocale();
  const today = dhakaToday();
  const asOf = asOfFrom(search, today);
  const report = useQuery({
    queryKey: ['ledger', 'trial-balance', asOf],
    queryFn: () => trialBalance(asOf),
  });

  return (
    <>
      <DateInput
        label={a('accounts.reports.asOf')}
        value={asOf}
        max={today}
        onChange={(value) => go({ asOf: value })}
      />
      <Block title={a('accounts.ledger.trial')} caption={asOf}>
        {report.isPending ? (
          <LoadingRows rows={8} />
        ) : report.isError ? (
          <LoadFailed onRetry={() => void report.refetch()} />
        ) : report.data.items.length === 0 ? (
          <Empty label="accounts.ledger.empty" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="h-row px-4 text-left font-medium">
                    {a('accounts.col.account')}
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    {a('accounts.col.debit')}
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    {a('accounts.col.credit')}
                  </th>
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    {a('accounts.col.balance')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.data.items.map((row) => (
                  <tr key={row.accountId} className="border-b border-border hover:bg-accent">
                    <td className="h-row px-4">
                      <Link
                        to="/accounts/ledger"
                        search={{ view: 'account', account: row.accountId, to: asOf }}
                        className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                          {row.code}
                        </span>
                        {row.name}
                      </Link>
                    </td>
                    <AmountCell poisha={row.debitPoisha} />
                    <AmountCell poisha={row.creditPoisha} />
                    <AmountCell poisha={row.balancePoisha} />
                  </tr>
                ))}
                <tr className="bg-muted/40 font-semibold">
                  <td className="h-row px-4">{a('accounts.reports.total')}</td>
                  <td className="h-row px-4 text-right">
                    <Money poisha={report.data.totalDebitPoisha} locale={locale} />
                  </td>
                  <td className="h-row px-4 text-right">
                    <Money poisha={report.data.totalCreditPoisha} locale={locale} />
                  </td>
                  <td className="h-row px-4 text-right">
                    <StatusBadge tone={report.data.differencePoisha === '0' ? 'success' : 'danger'}>
                      {report.data.differencePoisha === '0'
                        ? a('accounts.reports.balanced')
                        : a('accounts.ledger.outOfBalance')}
                    </StatusBadge>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {report.data === undefined ? null : <CostWithheld withheld={report.data.costWithheld} />}
      </Block>
    </>
  );
}

function DayBookView({ search, go }: ViewProps) {
  const a = useAccountsT();
  const source = useSourceLabel();
  const today = dhakaToday();
  // One day by default: the day book is read a day at a time, and the server
  // refuses more than 31.
  const range =
    search.from === undefined && search.to === undefined
      ? { from: today, to: today }
      : rangeFrom(search, today);
  const report = useQuery({
    queryKey: ['ledger', 'day-book', range.from, range.to],
    queryFn: () => dayBook(range),
  });

  return (
    <>
      <RangeBar
        from={range.from}
        to={range.to}
        today={today}
        onChange={(next) => go(next)}
        onPreset={(preset) => go(presetRange(preset, today))}
      />
      <Block title={a('accounts.ledger.daybook')} caption={`${range.from} – ${range.to}`}>
        {report.isPending ? (
          <LoadingRows rows={6} />
        ) : report.isError ? (
          <LoadFailed onRetry={() => void report.refetch()} />
        ) : report.data.items.length === 0 ? (
          <Empty label="accounts.ledger.dayEmpty" />
        ) : (
          <ol className="divide-y divide-border">
            {report.data.items.map((journal) => (
              <li key={journal.journalId} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">
                    {journal.memo ?? source(journal.sourceType)}
                    {journal.reversesJournalId === null ? null : (
                      <StatusBadge tone="warning" className="ml-2">
                        {a('accounts.ledger.reversal')}
                      </StatusBadge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {journal.businessDate} · {source(journal.sourceType)}
                  </p>
                </div>
                <table className="mt-2 w-full text-sm">
                  <caption className="sr-only">
                    {journal.memo ?? source(journal.sourceType)}
                  </caption>
                  <tbody>
                    {journal.lines.map((line) => (
                      <tr key={line.lineNo}>
                        <td className="py-0.5 pr-4">
                          <span className="mr-2 font-mono text-xs text-muted-foreground">
                            {line.accountCode}
                          </span>
                          {line.accountName}
                        </td>
                        <AmountCell poisha={line.debitPoisha} />
                        <AmountCell poisha={line.creditPoisha} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            ))}
          </ol>
        )}
        {report.data?.truncated === true ? (
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {a('accounts.statement.truncated')}
          </p>
        ) : null}
        {report.data === undefined ? null : <CostWithheld withheld={report.data.costWithheld} />}
      </Block>
    </>
  );
}

function AccountView({ search, go }: ViewProps) {
  const a = useAccountsT();
  const id = useId();
  const today = dhakaToday();
  const range = rangeFrom(search, today);
  const accounts = useQuery({ queryKey: ['ledger', 'accounts'], queryFn: ledgerAccounts });
  const accountId = search.account;
  const statement = useQuery({
    queryKey: ['ledger', 'account-ledger', accountId ?? '', range.from, range.to],
    queryFn: () => accountLedger(accountId ?? '', range),
    enabled: accountId !== undefined,
  });

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor={id} className="block">
            {a('accounts.col.account')}
          </Label>
          <select
            id={id}
            value={accountId ?? ''}
            onChange={(event) =>
              go({ account: event.target.value === '' ? undefined : event.target.value })
            }
            className="h-control-sm w-72 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <option value="">{a('accounts.ledger.pickAccount')}</option>
            {(accounts.data?.items ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {`${account.code} · ${account.name}`}
              </option>
            ))}
          </select>
        </div>
        <RangeBar
          from={range.from}
          to={range.to}
          today={today}
          onChange={(next) => go(next)}
          onPreset={(preset) => go(presetRange(preset, today))}
        />
      </div>
      <Block title={a('accounts.ledger.account')}>
        {accountId === undefined ? (
          <Empty label="accounts.ledger.pickAccount" />
        ) : statement.isPending ? (
          <LoadingRows rows={6} />
        ) : statement.isError ? (
          <LoadFailed onRetry={() => void statement.refetch()} />
        ) : (
          <StatementTable statement={statement.data} />
        )}
      </Block>
    </>
  );
}
