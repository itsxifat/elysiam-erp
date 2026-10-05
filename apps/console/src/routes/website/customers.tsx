import { Button, DateTime, StatusBadge } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { customersPath } from '../customers/customers-nav.js';
import { listAccounts, type WebsiteAccount } from './api.js';
import { useWebsiteT } from './messages.js';
import { control, Empty, Field, Loadable, NamedSection, WebsitePage } from './parts.js';
import '../../i18n/website.js';

/**
 * Website → Customers (M34, D-522, D-533): the website's accounts, whether each verified its
 * email, how it signs in, when it last did, and the buyer it is linked to. Read only: a
 * shopper's account is theirs to change, on the website.
 */
export function WebsiteCustomersPage() {
  const t = useWebsiteT();
  const id = useId();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ['website', 'accounts', search, offset],
    queryFn: () => listAccounts({ q: search, offset }),
  });
  return (
    <WebsitePage tab="/website/customers" wide>
      <NamedSection title={t('web.cust.title')} description={t('web.cust.description')}>
        <div className="mb-4 max-w-sm">
          <Field id={`${id}-search`} label={t('web.cust.search')}>
            <input
              id={`${id}-search`}
              type="search"
              value={search}
              maxLength={64}
              className={control}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
          </Field>
        </div>
        <Loadable query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <Empty />
            ) : (
              <>
                <AccountsTable items={data.items} />
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {t('web.cust.total')} {data.total}
                  </span>
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - 50))}
                    >
                      {t('web.cust.previous')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={offset + 50 >= data.total}
                      onClick={() => setOffset(offset + 50)}
                    >
                      {t('web.cust.next')}
                    </Button>
                  </span>
                </div>
              </>
            )
          }
        </Loadable>
      </NamedSection>
    </WebsitePage>
  );
}

function AccountsTable({ items }: { readonly items: readonly WebsiteAccount[] }) {
  const t = useWebsiteT();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
        <caption className="sr-only">{t('web.cust.title')}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="font-medium">{t('web.cust.name')}</th>
            <th className="font-medium">{t('web.cust.email')}</th>
            <th className="font-medium">{t('web.cust.verified')}</th>
            <th className="font-medium">{t('web.cust.signIn')}</th>
            <th className="text-right font-medium">{t('web.cust.orders')}</th>
            <th className="font-medium">{t('web.cust.lastSignIn')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((account) => (
            <tr key={account.id} className="h-row border-b border-border last:border-b-0">
              <td className="font-medium">
                {account.customerId === null ? (
                  account.name
                ) : (
                  <Link
                    to={customersPath(`/customers/${account.customerId}`)}
                    className="underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {account.name}
                  </Link>
                )}
              </td>
              <td className="break-all">{account.email}</td>
              <td>
                <StatusBadge tone={account.emailVerified ? 'success' : 'warning'}>
                  {account.emailVerified ? t('web.cust.yes') : t('web.cust.no')}
                </StatusBadge>
              </td>
              <td className="text-xs text-muted-foreground">
                {account.googleLinked ? t('web.cust.google') : t('web.cust.password')}
                {account.source === 'legacy_import' ? ` · ${t('web.cust.imported')}` : ''}
              </td>
              <td className="text-right tabular-nums">{account.orderCount}</td>
              <td>
                {account.lastSignInAt === null ? (
                  <span className="text-muted-foreground">{t('web.keys.never')}</span>
                ) : (
                  <DateTime value={account.lastSignInAt} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
