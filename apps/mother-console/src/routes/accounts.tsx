import { EmptyState, ErrorState, Money, PageHeader, Section, Skeleton } from '@elysium/ui';
import { WALLET_KINDS, type ProfitAndLossWire } from '@elysium/mother-shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';

import { endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { BrandFreshness } from '../ui/brand-status.js';
import { RangeBar } from '../ui/range-bar.js';
import { rangeOf } from '../ui/range.js';

/**
 * Accounts across brands (M32 screen 4; D-493): the consolidated wallets and profit and
 * loss that left the brand ERP (M31), from each brand's own ledger as last read. Income is
 * net of the discounts given, as the brand's own P&L nets them.
 */

const route = getRouteApi('/accounts');

const WALLET_LABEL: Readonly<Record<(typeof WALLET_KINDS)[number], MessageKey>> = {
  wallet_cash: 'walletKind.wallet_cash',
  wallet_bank: 'walletKind.wallet_bank',
  wallet_bkash: 'walletKind.wallet_bkash',
  wallet_mfs_other: 'walletKind.wallet_mfs_other',
};

const SUBTYPE: Readonly<Record<string, MessageKey>> = {
  sales_revenue: 'subtype.sales_revenue',
  sales_discounts: 'subtype.sales_discounts',
  delivery_charge_income: 'subtype.delivery_charge_income',
  other_income: 'subtype.other_income',
  inventory_adjustment_gain: 'subtype.inventory_adjustment_gain',
  cogs: 'subtype.cogs',
  courier_charges: 'subtype.courier_charges',
  return_charges: 'subtype.return_charges',
  ad_spend: 'subtype.ad_spend',
  salary_expense: 'subtype.salary_expense',
  bonus_expense: 'subtype.bonus_expense',
  interest_expense: 'subtype.interest_expense',
  inventory_writeoff: 'subtype.inventory_writeoff',
  purchase_price_variance: 'subtype.purchase_price_variance',
  cash_over_short: 'subtype.cash_over_short',
  bank_charges: 'subtype.bank_charges',
  operating_expense: 'subtype.operating_expense',
};

export function AccountsPage() {
  const { t, locale } = useLocale();
  const search = route.useSearch();
  const navigate = useNavigate();
  const range = rangeOf(search);
  const wallets = useQuery({ queryKey: ['wallets'], queryFn: endpoints.wallets });
  const pnl = useQuery({
    queryKey: ['pnl', range.from, range.to],
    queryFn: () => endpoints.profitAndLoss(range.from, range.to),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-8">
      <PageHeader title={t('accounts.title')} description={t('accounts.description')} />

      <Section title={t('accounts.wallets')} bodyClassName="p-0">
        {wallets.isPending ? (
          <Skeleton className="m-5 h-32" />
        ) : wallets.isError ? (
          <ErrorState title={t('common.error')} detail={t('common.errorDetail')} className="m-5" />
        ) : wallets.data.brands.length === 0 ? (
          <EmptyState icon={Landmark} title={t('overview.noBrands')} className="m-5" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">{t('accounts.wallets')}</caption>
              <thead>
                <tr className="border-y border-border text-xs text-muted-foreground">
                  <th scope="col" className="px-5 py-2 text-left font-medium">
                    {t('overview.brand')}
                  </th>
                  {WALLET_KINDS.map((kind) => (
                    <th key={kind} scope="col" className="px-3 py-2 text-right font-medium">
                      {t(WALLET_LABEL[kind])}
                    </th>
                  ))}
                  <th scope="col" className="px-5 py-2 text-right font-medium">
                    {t('common.total')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {wallets.data.brands.map((row) => (
                  <tr key={row.brand.id} className="border-b border-border">
                    <th scope="row" className="px-5 py-2 text-left font-normal">
                      <span className="font-medium">{row.brand.displayName}</span>
                      <div className="mt-0.5">
                        <BrandFreshness brand={row.brand} />
                      </div>
                    </th>
                    {WALLET_KINDS.map((kind) => (
                      <td key={kind} className="px-3 py-2 text-right tabular-nums">
                        {row.cashByKind === null ? (
                          '—'
                        ) : (
                          <Money poisha={row.cashByKind[kind]} locale={locale} />
                        )}
                      </td>
                    ))}
                    <td className="px-5 py-2 text-right font-medium tabular-nums">
                      {row.totalPoisha === null ? (
                        t('accounts.notRead')
                      ) : (
                        <Money poisha={row.totalPoisha} locale={locale} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-medium">
                  <th scope="row" className="px-5 py-2.5 text-left">
                    {t('overview.allBrands')}
                  </th>
                  {WALLET_KINDS.map((kind) => (
                    <td key={kind} className="px-3 py-2.5 text-right tabular-nums">
                      <Money poisha={wallets.data.cashByKind[kind]} locale={locale} />
                    </td>
                  ))}
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    <Money poisha={wallets.data.totalPoisha} locale={locale} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Section>

      <div className="space-y-4">
        <RangeBar
          value={range}
          onChange={(next) =>
            void navigate({ to: '/accounts', search: { from: next.from, to: next.to } })
          }
        />
        <Section title={t('accounts.pnl')} bodyClassName="p-0">
          {pnl.isPending ? (
            <Skeleton className="m-5 h-32" />
          ) : pnl.isError ? (
            <ErrorState
              title={t('common.error')}
              detail={t('common.errorDetail')}
              className="m-5"
            />
          ) : (
            <ProfitAndLoss data={pnl.data} dim={pnl.isPlaceholderData} />
          )}
        </Section>
      </div>
    </div>
  );
}

function ProfitAndLoss({ data, dim }: { readonly data: ProfitAndLossWire; readonly dim: boolean }) {
  const { t, locale } = useLocale();
  const label = (subtype: string) =>
    SUBTYPE[subtype] === undefined ? subtype : t(SUBTYPE[subtype] ?? 'subtype.sales_revenue');
  return (
    <div className={dim ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}>
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">{t('accounts.pnl')}</caption>
        <thead>
          <tr className="border-y border-border text-xs text-muted-foreground">
            <th scope="col" className="px-5 py-2 text-left font-medium">
              {t('overview.brand')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('accounts.income')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('accounts.expense')}
            </th>
            <th scope="col" className="px-5 py-2 text-right font-medium">
              {t('accounts.net')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.brands.map((row) => (
            <tr key={row.brand.id} className="border-b border-border align-top">
              <th scope="row" className="px-5 py-2 text-left font-normal">
                <details>
                  <summary className="cursor-pointer font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    {row.brand.displayName}
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {row.lines.map((line) => (
                      <li
                        key={`${line.accountClass}:${line.subtype}`}
                        className="flex justify-between gap-6"
                      >
                        <span>{label(line.subtype)}</span>
                        <Money poisha={line.amountPoisha} locale={locale} />
                      </li>
                    ))}
                  </ul>
                </details>
              </th>
              <td className="px-3 py-2 text-right tabular-nums">
                <Money poisha={row.incomePoisha} locale={locale} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                <Money poisha={row.expensePoisha} locale={locale} />
              </td>
              <td className="px-5 py-2 text-right font-medium tabular-nums">
                <Money poisha={row.netPoisha} locale={locale} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <th scope="row" className="px-5 py-2.5 text-left">
              {t('overview.allBrands')}
            </th>
            <td className="px-3 py-2.5 text-right tabular-nums">
              <Money poisha={data.incomePoisha} locale={locale} />
            </td>
            <td className="px-3 py-2.5 text-right tabular-nums">
              <Money poisha={data.expensePoisha} locale={locale} />
            </td>
            <td className="px-5 py-2.5 text-right tabular-nums">
              <Money poisha={data.netPoisha} locale={locale} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
