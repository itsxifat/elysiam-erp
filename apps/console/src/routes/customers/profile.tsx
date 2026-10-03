import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Cake, Heart } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { paramOf } from '../courier/courier-nav.js';
import { isOrdersKey, useOrdersT } from '../orders/messages.js';
import { ordersPath } from '../orders/paths.js';
import { buyerProfile, updateOccasions, type BuyerProfile } from './api.js';
import { customersPath } from './customers-nav.js';
import { isCustomersKey, useCustomersT } from './messages.js';
import { DatePicker } from '../../ui/date-picker.js';

/** A birthday or an anniversary can be decades back: the calendar lists the years. */
const OCCASION_YEARS = { from: 1930, to: new Date().getUTCFullYear() } as const;

/**
 * One buyer's profile (M16; §10 "Buyer stats").
 *
 * The totals are the brand's view of the buyer; the orders listed are only those the
 * caller could open (D-208), so a sales agent may see "Orders 7" above three rows. A buyer
 * outside the caller's reach is a 404, shown as "no such buyer" — the same answer the
 * server gives, on purpose.
 */
export function BuyerProfilePage() {
  const ability = useAbility();
  const t = useCustomersT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Customer')}
      explain={{ title: t('customers.deniedTitle'), detail: t('customers.deniedDetail') }}
    >
      <Profile />
    </PermissionGate>
  );
}

function Profile() {
  const t = useCustomersT();
  const customerId = paramOf(useParams({ strict: false }), 'customerId');
  const profile = useQuery({
    queryKey: ['customers', 'profile', customerId],
    queryFn: () => buyerProfile(customerId),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  const back = (
    <Link
      to={customersPath('/customers')}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t('customers.profile.back')}
    </Link>
  );

  if (profile.isPending) {
    return (
      <div className="space-y-4">
        {back}
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (profile.error instanceof ApiError && profile.error.status === 404) {
    return (
      <div className="space-y-4">
        {back}
        <EmptyState
          title={t('customers.profile.notFound')}
          detail={t('customers.profile.notFoundDetail')}
        />
      </div>
    );
  }
  if (profile.isError) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorState
          title={t('customers.errorTitle')}
          detail={t('customers.errorDetail')}
          action={
            <Button variant="outline" size="sm" onClick={() => void profile.refetch()}>
              {t('customers.retry')}
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {back}
      <ProfileBody profile={profile.data} />
    </div>
  );
}

function segmentLabel(t: ReturnType<typeof useCustomersT>, segment: string): string {
  const key = `customers.segment.${segment}`;
  return isCustomersKey(key) ? t(key) : segment;
}

function ProfileBody({ profile }: { readonly profile: BuyerProfile }) {
  const t = useCustomersT();
  const { locale } = useLocale();
  const { customer } = profile;
  const stats = customer.stats;

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">{customer.name}</h1>
          <p className="text-sm text-muted-foreground tabular-nums">{customer.phone}</p>
        </div>
        <StatusBadge tone={profile.segment === null ? 'neutral' : 'info'}>
          {profile.segment === null
            ? t('customers.profile.segmentNone')
            : segmentLabel(t, profile.segment.segment)}
        </StatusBadge>
      </header>

      <section aria-label={t('customers.profile.stats')}>
        <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          <Tile label={t('customers.profile.ltv')}>
            <Money poisha={stats.ltvPoisha} locale={locale} />
          </Tile>
          <Tile label={t('customers.profile.aov')}>
            {profile.averageOrderPoisha === null ? (
              <span className="text-muted-foreground">{t('customers.profile.none')}</span>
            ) : (
              <Money poisha={profile.averageOrderPoisha} locale={locale} />
            )}
          </Tile>
          <Tile label={t('customers.profile.firstOrder')}>
            <When value={stats.firstOrderAt} />
          </Tile>
          <Tile label={t('customers.profile.lastOrder')}>
            <When value={stats.lastOrderAt} />
          </Tile>
          <Tile label={t('customers.profile.orders')}>{stats.orders}</Tile>
          <Tile label={t('customers.profile.delivered')}>{stats.delivered}</Tile>
          <Tile label={t('customers.profile.returned')}>{stats.returned}</Tile>
          <Tile label={t('customers.profile.cancelled')}>{stats.cancelled}</Tile>
        </dl>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={t('customers.profile.favourites')}>
          {profile.favourites.categories.length === 0 && profile.favourites.sizes.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {t('customers.profile.noFavourites')}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 px-4 py-3">
              <Ranked
                title={t('customers.profile.categories')}
                items={profile.favourites.categories.map((item) => [item.name, item.units])}
              />
              <Ranked
                title={t('customers.profile.sizes')}
                items={profile.favourites.sizes.map((item) => [item.label, item.units])}
              />
            </div>
          )}
        </Panel>

        <Panel title={t('customers.profile.segment')}>
          {profile.segment === null ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {t('customers.profile.segmentNone')}
            </p>
          ) : (
            <dl className="grid grid-cols-3 gap-2 px-4 py-3 text-sm">
              <Score label={t('customers.profile.recency')} value={profile.segment.recency} />
              <Score label={t('customers.profile.frequency')} value={profile.segment.frequency} />
              <Score label={t('customers.profile.monetary')} value={profile.segment.monetary} />
              <div className="col-span-3 text-xs text-muted-foreground">
                {t('customers.profile.scoredOn')}{' '}
                <span className="tabular-nums">{profile.segment.computedOn}</span>
              </div>
            </dl>
          )}
        </Panel>

        <Panel title={t('customers.profile.occasions')}>
          <OccasionDates customer={customer} />
          <div className="border-t border-border px-4 py-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t('customers.profile.greetings')}
            </h3>
            {profile.greetings.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('customers.profile.noGreetings')}
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {profile.greetings.map((greeting) => (
                  <li
                    key={`${greeting.occasion}-${String(greeting.year)}`}
                    className="flex justify-between gap-2"
                  >
                    <span>
                      {isCustomersKey(`customers.occasion.${greeting.occasion}`)
                        ? t(
                            `customers.occasion.${greeting.occasion}` as 'customers.occasion.birthday',
                          )
                        : greeting.occasion}{' '}
                      <span className="tabular-nums">{greeting.year}</span>
                    </span>
                    <DateTime value={greeting.sentAt} dateOnly className="text-muted-foreground" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>

      <RecentOrders profile={profile} />
    </>
  );
}

function RecentOrders({ profile }: { readonly profile: BuyerProfile }) {
  const t = useCustomersT();
  const tOrders = useOrdersT();
  const { locale } = useLocale();
  return (
    <Panel title={t('customers.profile.recent')}>
      {profile.recentOrders.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('customers.profile.noOrders')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('customers.profile.order')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('customers.profile.status')}
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  {t('customers.profile.cod')}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t('customers.profile.placed')}
                </th>
              </tr>
            </thead>
            <tbody>
              {profile.recentOrders.map((order) => {
                const status = `orders.status.${order.status}`;
                return (
                  <tr key={order.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        to={ordersPath(`/orders/${order.id}`)}
                        className="font-medium tabular-nums underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {order.orderNo}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      {isOrdersKey(status) ? tOrders(status) : order.status}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Money poisha={order.codAmountPoisha} locale={locale} />
                    </td>
                    <td className="px-4 py-2">
                      <DateTime value={order.createdAt} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function When({ value }: { readonly value: string | null }) {
  const t = useCustomersT();
  return value === null ? (
    <span className="text-muted-foreground">{t('customers.profile.none')}</span>
  ) : (
    <DateTime value={value} dateOnly />
  );
}

function Tile({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-base font-semibold text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function Panel({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Ranked({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly (readonly [string, number])[];
}) {
  const t = useCustomersT();
  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">—</p>
      ) : (
        <ol className="mt-1 space-y-1 text-sm">
          {items.map(([name, units]) => (
            <li key={name} className="flex justify-between gap-2">
              <span className="truncate">{name}</span>
              <span className="text-muted-foreground tabular-nums">
                {units} {t('customers.profile.units')}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Score({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{value}/5</dd>
    </div>
  );
}

function Occasion({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string | null;
}) {
  const t = useCustomersT();
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="inline-flex items-center gap-1.5">
        {icon}
        {label}
      </dt>
      <dd className="tabular-nums">
        {value ?? <span className="text-muted-foreground">{t('customers.profile.notSet')}</span>}
      </dd>
    </div>
  );
}

/**
 * The buyer's birthday and anniversary, and — for a role that may update the buyer — the
 * place they are captured (M16 Build: "birthday and anniversary capture"). The occasions
 * job greets on these dates, so an empty field removes a date rather than leaving a wrong
 * one in place.
 */
function OccasionDates({ customer }: { readonly customer: BuyerProfile['customer'] }) {
  const t = useCustomersT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [birthday, setBirthday] = useState(customer.birthday ?? '');
  const [anniversary, setAnniversary] = useState(customer.anniversary ?? '');

  const save = useMutation({
    mutationFn: () =>
      updateOccasions(customer.id, {
        birthday: birthday === '' ? null : birthday,
        anniversary: anniversary === '' ? null : anniversary,
      }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['customers', 'profile', customer.id] });
    },
  });

  if (!editing) {
    return (
      <div className="space-y-2 px-4 py-3 text-sm">
        <dl className="space-y-2">
          <Occasion
            icon={<Cake aria-hidden="true" className="size-4 text-muted-foreground" />}
            label={t('customers.occasion.birthday')}
            value={customer.birthday}
          />
          <Occasion
            icon={<Heart aria-hidden="true" className="size-4 text-muted-foreground" />}
            label={t('customers.occasion.anniversary')}
            value={customer.anniversary}
          />
        </dl>
        {ability.can('update', 'Customer') ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setBirthday(customer.birthday ?? '');
              setAnniversary(customer.anniversary ?? '');
              setEditing(true);
            }}
          >
            {t('customers.profile.editDates')}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="space-y-3 px-4 py-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label htmlFor={`${id}-birthday`} className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            {t('customers.occasion.birthday')}
          </span>
          <DatePicker
            id={`${id}-birthday`}
            value={birthday}
            clearable
            years={OCCASION_YEARS}
            onValueChange={setBirthday}
          />
        </label>
        <label htmlFor={`${id}-anniversary`} className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">
            {t('customers.occasion.anniversary')}
          </span>
          <DatePicker
            id={`${id}-anniversary`}
            value={anniversary}
            clearable
            years={OCCASION_YEARS}
            onValueChange={setAnniversary}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('customers.profile.datesHint')}</p>
      {save.isError ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {t('customers.profile.datesFailed')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {t('customers.profile.saveDates')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          {t('customers.profile.cancel')}
        </Button>
      </div>
    </form>
  );
}
