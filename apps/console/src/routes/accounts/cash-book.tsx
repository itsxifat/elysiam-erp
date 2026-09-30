import { PermissionGate } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { useAbility } from '../../auth/session.js';
import {
  AccountsNav,
  Block,
  LoadFailed,
  LoadingRows,
  RangeBar,
  StatementTable,
} from './accounts-parts.js';
import { cashBook, dhakaToday } from './api.js';
import { useAccountsT } from './messages.js';
import { presetRange, rangeFrom } from './report-dates.js';

/**
 * One wallet's cash book (M03's report, reached from the accounts screen).
 *
 * The account ledger of the wallet, plus the other side of each entry by name —
 * "Cash out · Rent", "Transfer · Bank" — so a person reading their till's history
 * sees what each movement was for without opening the journal. Never the other
 * side's amounts: against a cost account that would be a purchase cost (D-085).
 *
 * The range is in the URL, so "the Gulshan till for August" is a link.
 */
export function CashBookPage() {
  const { accountId } = useParams({ from: '/accounts/wallets/$accountId' });
  const search = useSearch({ from: '/accounts/wallets/$accountId' });
  const navigate = useNavigate();
  const a = useAccountsT();
  const ability = useAbility();
  const today = dhakaToday();
  const range = rangeFrom(search, today);

  const book = useQuery({
    queryKey: ['ledger', 'cash-book', accountId, range.from, range.to],
    queryFn: () => cashBook(accountId, range),
    enabled: ability.can('read', 'Wallet'),
  });

  const setRange = (next: { from: string; to: string }) =>
    void navigate({
      to: '/accounts/wallets/$accountId',
      params: { accountId },
      search: next,
      replace: true,
    });

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link
          to="/accounts"
          className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {a('accounts.book.back')}
        </Link>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {book.data === undefined
              ? a('accounts.book.title')
              : `${book.data.account.code} · ${book.data.account.name}`}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{a('accounts.book.subtitle')}</p>
        </div>
        <AccountsNav />
      </header>

      <PermissionGate
        allowed={ability.can('read', 'Wallet')}
        explain={{ title: a('accounts.deniedTitle'), detail: a('accounts.deniedDetail') }}
      >
        <RangeBar
          from={range.from}
          to={range.to}
          today={today}
          onChange={setRange}
          onPreset={(preset) => setRange(presetRange(preset, today))}
        />
        <Block title={a('accounts.book.title')}>
          {book.isPending ? (
            <LoadingRows rows={6} />
          ) : book.isError ? (
            <LoadFailed onRetry={() => void book.refetch()} />
          ) : (
            <StatementTable statement={book.data} />
          )}
        </Block>
      </PermissionGate>
    </div>
  );
}
