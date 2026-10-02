import { Button, Input, Label, Money, Skeleton } from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';

import { useAbility, useSession } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import type { Statement } from './api.js';
import { useAccountsT, type AccountsMessageKey } from './messages.js';
import type { IsoDate, RangePreset } from './report-dates.js';

/**
 * Pieces every money screen shares: the section's tabs, a titled block, the range
 * bar, and the statement table the cash book and the account ledger both render.
 *
 * One statement table for both on purpose: a cash book is an account ledger with
 * the other side of each entry named, and two tables for one shape drift apart the
 * first time one of them gains a column.
 */

const TAB =
  'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const ACTIVE = { className: `${TAB} bg-muted font-medium text-foreground` };

const SOURCES: Readonly<Record<string, AccountsMessageKey>> = {
  cash_in: 'accounts.source.cash_in',
  cash_out: 'accounts.source.cash_out',
  petty_cash: 'accounts.source.petty_cash',
  wallet_transfer: 'accounts.source.wallet_transfer',
  wallet_closing: 'accounts.source.wallet_closing',
  order: 'accounts.source.order',
  customer_advance: 'accounts.source.customer_advance',
  pos_sale: 'accounts.source.pos_sale',
  pos_return: 'accounts.source.pos_return',
  supply: 'accounts.source.supply',
  supply_return: 'accounts.source.supply_return',
  supplier_payment: 'accounts.source.supplier_payment',
  advance_application: 'accounts.source.advance_application',
  courier_settlement: 'accounts.source.courier_settlement',
  stock_adjustment: 'accounts.source.stock_adjustment',
  payroll_run: 'accounts.source.payroll_run',
  employee_loan: 'accounts.source.employee_loan',
  investment: 'accounts.source.investment',
  investor_distribution: 'accounts.source.investor_distribution',
  investor_withdrawal: 'accounts.source.investor_withdrawal',
};

/** What an entry came from, in words: `wallet_transfer` is not a description. */
export function useSourceLabel(): (sourceType: string) => string {
  const a = useAccountsT();
  return (sourceType) => {
    const key = SOURCES[sourceType];
    return key === undefined ? sourceType : a(key);
  };
}

/** The Accounts section's tabs, each shown only to a role that can open it. */
export function AccountsNav() {
  const a = useAccountsT();
  const ability = useAbility();
  const session = useSession();
  const reports = ability.can('read', 'LedgerReport');

  return (
    <nav aria-label={a('accounts.title')} className="flex flex-wrap gap-1">
      <Link to="/accounts" className={TAB} activeProps={ACTIVE} activeOptions={{ exact: true }}>
        {a('accounts.nav.cash')}
      </Link>
      {ability.can('update', 'Wallet') ? (
        <Link to="/accounts/transfers" className={TAB} activeProps={ACTIVE}>
          {a('accounts.nav.transfers')}
        </Link>
      ) : null}
      {ability.can('create', 'Wallet') || ability.can('update', 'Wallet') ? (
        // Exact: `/accounts/wallets/$accountId` is a cash book, not this tab.
        <Link
          to="/accounts/wallets"
          className={TAB}
          activeProps={ACTIVE}
          activeOptions={{ exact: true }}
        >
          {a('accounts.nav.wallets')}
        </Link>
      ) : null}
      {ability.can('create', 'Wallet') ? (
        // M17: claims to verify and refunds owed. `create Wallet` is accounts' grant (D-235).
        <Link to="/accounts/advances" className={TAB} activeProps={ACTIVE}>
          {a('accounts.nav.advances')}
        </Link>
      ) : null}
      {reports ? (
        <Link to="/accounts/reports" className={TAB} activeProps={ACTIVE}>
          {a('accounts.nav.reports')}
        </Link>
      ) : null}
      {reports ? (
        <Link to="/accounts/ledger" className={TAB} activeProps={ACTIVE}>
          {a('accounts.nav.ledger')}
        </Link>
      ) : null}
      {ability.can('read', 'LedgerPeriod') ? (
        <Link to="/accounts/periods" className={TAB} activeProps={ACTIVE}>
          {a('accounts.nav.periods')}
        </Link>
      ) : null}
      {session.context?.isSuperAdmin === true ? (
        <Link to="/accounts/consolidated" className={TAB} activeProps={ACTIVE}>
          {a('accounts.nav.consolidated')}
        </Link>
      ) : null}
    </nav>
  );
}

/** A page header with the section tabs under it. */
export function AccountsHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {actions}
      </div>
      <AccountsNav />
    </header>
  );
}

/** A titled, hairline-bordered block. Separation is a border, never a shadow (§24). */
export function Block({
  title,
  caption,
  action,
  children,
}: {
  readonly title: string;
  readonly caption?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {caption === undefined ? null : (
            <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function LoadingRows({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-row w-full" />
      ))}
    </div>
  );
}

/** A report's failure, said in words and not shown as an empty report. */
export function LoadFailed({ onRetry }: { readonly onRetry: () => void }) {
  const a = useAccountsT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" role="alert">
      <p className="text-sm text-foreground">{a('accounts.report.failed')}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {a('accounts.report.retry')}
      </Button>
    </div>
  );
}

export function Empty({ label }: { readonly label: AccountsMessageKey }) {
  const a = useAccountsT();
  return <p className="px-4 py-3 text-sm text-muted-foreground">{a(label)}</p>;
}

/** Said whenever the server withheld cost; a report that looks complete but is not misleads. */
export function CostWithheld({ withheld }: { readonly withheld: boolean }) {
  const a = useAccountsT();
  if (!withheld) return null;
  return (
    <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
      {a('accounts.costWithheld')}
    </p>
  );
}

export function DateInput({
  label,
  value,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: IsoDate;
  readonly max?: IsoDate;
  readonly onChange: (value: IsoDate) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="block">
        {label}
      </Label>
      <Input
        id={id}
        type="date"
        value={value}
        max={max}
        className="h-control-sm w-40"
        onChange={(event) => {
          if (event.target.value !== '') onChange(event.target.value);
        }}
      />
    </div>
  );
}

const PRESET_LABELS: Record<RangePreset, AccountsMessageKey> = {
  today: 'accounts.range.today',
  thisMonth: 'accounts.range.thisMonth',
  lastMonth: 'accounts.range.lastMonth',
  thisYear: 'accounts.range.thisYear',
};

/** A from-to pair with the four presets people actually use. */
export function RangeBar({
  from,
  to,
  today,
  onChange,
  onPreset,
}: {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly today: IsoDate;
  readonly onChange: (range: { from: IsoDate; to: IsoDate }) => void;
  readonly onPreset: (preset: RangePreset) => void;
}) {
  const a = useAccountsT();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <DateInput
        label={a('accounts.range.from')}
        value={from}
        max={to}
        onChange={(value) => onChange({ from: value, to })}
      />
      <DateInput
        label={a('accounts.range.to')}
        value={to}
        max={today}
        onChange={(value) => onChange({ from: value <= from ? value : from, to: value })}
      />
      <div role="group" aria-label={a('accounts.range.presets')} className="flex flex-wrap gap-1">
        {(Object.keys(PRESET_LABELS) as RangePreset[]).map((preset) => (
          <Button key={preset} variant="outline" size="sm" onClick={() => onPreset(preset)}>
            {a(PRESET_LABELS[preset])}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** A money cell: right-aligned, tabular, and a dash rather than ৳0.00 for "none". */
export function AmountCell({ poisha }: { readonly poisha: string }) {
  const { locale } = useLocale();
  return (
    <td className="h-row px-4 text-right">
      {poisha === '0' ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <Money poisha={poisha} locale={locale} />
      )}
    </td>
  );
}

/**
 * An account's lines for a range: opening balance, each line with its running
 * balance, and the closing balance. Every figure is the server's.
 */
export function StatementTable({ statement }: { readonly statement: Statement }) {
  const a = useAccountsT();
  const source = useSourceLabel();
  const { locale } = useLocale();
  const showAgainst = statement.items.some((line) => line.against !== undefined);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">
          {statement.account.code} {statement.account.name}
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="h-row px-4 text-left font-medium">
              {a('accounts.col.date')}
            </th>
            <th scope="col" className="h-row px-4 text-left font-medium">
              {a('accounts.col.memo')}
            </th>
            {showAgainst ? (
              <th scope="col" className="h-row px-4 text-left font-medium">
                {a('accounts.col.against')}
              </th>
            ) : null}
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
          <tr className="border-b border-border bg-muted/40">
            <td className="h-row px-4 text-muted-foreground" colSpan={showAgainst ? 5 : 4}>
              {a('accounts.statement.opening')}
            </td>
            <td className="h-row px-4 text-right font-medium">
              <Money poisha={statement.openingBalancePoisha} locale={locale} />
            </td>
          </tr>
          {statement.items.map((line) => (
            <tr key={`${line.journalId}:${String(line.lineNo)}`} className="border-b border-border">
              <td className="h-row px-4 whitespace-nowrap tabular-nums">{line.businessDate}</td>
              <td className="px-4 py-1.5">{line.memo ?? source(line.sourceType)}</td>
              {showAgainst ? (
                <td className="px-4 py-1.5 text-muted-foreground">
                  {(line.against ?? []).map((entry) => `${entry.code} ${entry.name}`).join(', ')}
                </td>
              ) : null}
              <AmountCell poisha={line.debitPoisha} />
              <AmountCell poisha={line.creditPoisha} />
              <td className="h-row px-4 text-right">
                <Money poisha={line.balancePoisha} locale={locale} />
              </td>
            </tr>
          ))}
          <tr className="bg-muted/40 font-medium">
            <td className="h-row px-4" colSpan={showAgainst ? 3 : 2}>
              {a('accounts.statement.closing')}
            </td>
            <AmountCell poisha={statement.totalDebitPoisha} />
            <AmountCell poisha={statement.totalCreditPoisha} />
            <td className="h-row px-4 text-right">
              <Money poisha={statement.closingBalancePoisha} locale={locale} />
            </td>
          </tr>
        </tbody>
      </table>
      {statement.truncated ? (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {a('accounts.statement.truncated')}
        </p>
      ) : null}
    </div>
  );
}
