import type { MessageKey } from '@elysium/i18n';
import { Money, StatusBadge } from '@elysium/ui';
import { BadgePercent } from 'lucide-react';
import { useId } from 'react';

import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/order-edit.js';
import type { AppliedOffer, OfferRow } from './edit-api.js';
import { toggleOffer } from './order-edit-logic.js';

const REASONS = new Set([
  'min_order_not_met',
  'min_quantity_not_met',
  'limit_reached',
  'customer_limit_reached',
  'first_order_only',
  'out_of_scope',
  'nothing_to_discount',
]);

/**
 * The offers side panel (M50, D-921): the owner's words, "this panel will show only those offers
 * and discount we made before and after removing or returning which offer and discount it
 * qualifies for we can select from that and apply that".
 *
 * Every offer the brand is running for this buyer and channel, priced by the server against the
 * items as they stand: the ones that qualify first, each with what it takes off; the others
 * below with why they do not. A person ticks the ones to apply; one that does not combine
 * replaces the others (`toggleOffer`). What the server actually applied is what the totals
 * show, so a choice that stopped applying is visible before anything is saved.
 */
export function OffersPanel({
  offers,
  applied,
  selected,
  onChange,
  updating,
  failed,
}: {
  readonly offers: readonly OfferRow[] | undefined;
  readonly applied: readonly AppliedOffer[];
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly updating: boolean;
  readonly failed: boolean;
}) {
  const t = useT();
  const ids = useId();
  const all = offers ?? [];
  const qualifying = all.filter((offer) => offer.qualifies);
  // A chosen offer that stopped qualifying stays listed with the qualifying ones, so it can be
  // taken off.
  const others = all.filter((offer) => !offer.qualifies);

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="space-y-3 rounded-lg border border-border bg-card p-5"
    >
      <div className="space-y-1">
        <h2
          id={`${ids}-title`}
          className="flex items-center gap-2 text-base font-semibold tracking-tight"
        >
          <BadgePercent aria-hidden="true" className="size-4" />
          {t('oe.offers.title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('oe.offers.caption')}</p>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {updating ? t('oe.offers.updating') : ''}
      </p>
      {failed ? <p className="text-sm text-destructive">{t('oe.offers.error')}</p> : null}
      {offers !== undefined && all.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('oe.offers.none')}</p>
      ) : null}

      {qualifying.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">{t('oe.offers.qualifies')}</h3>
          <ul className="space-y-2">
            {qualifying.map((offer) => (
              <OfferItem
                key={offer.discountId}
                offer={offer}
                checked={selected.includes(offer.discountId)}
                applied={applied.find((entry) => entry.discountId === offer.discountId)}
                onToggle={() => onChange(toggleOffer(selected, offer, all))}
              />
            ))}
          </ul>
        </div>
      ) : offers !== undefined && all.length > 0 ? (
        <p className="text-sm text-muted-foreground">{t('oe.offers.noneQualify')}</p>
      ) : null}

      {others.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('oe.offers.notQualifying')}
          </h3>
          <ul className="space-y-2">
            {others.map((offer) => (
              <OfferItem
                key={offer.discountId}
                offer={offer}
                checked={selected.includes(offer.discountId)}
                applied={undefined}
                onToggle={() => onChange(toggleOffer(selected, offer, all))}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function OfferItem({
  offer,
  checked,
  applied,
  onToggle,
}: {
  readonly offer: OfferRow;
  readonly checked: boolean;
  readonly applied: AppliedOffer | undefined;
  readonly onToggle: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const id = useId();
  // A disqualified offer can be taken off but not put on.
  const disabled = !offer.qualifies && !checked;
  const goods = applied?.discountPoisha ?? offer.discountPoisha;
  const delivery = applied?.deliveryDiscountPoisha ?? offer.deliveryDiscountPoisha;
  const reasonKey = (
    offer.reason !== null && REASONS.has(offer.reason)
      ? `oe.offers.reason.${offer.reason}`
      : 'oe.offers.reason.other'
  ) as MessageKey;
  return (
    <li className="flex items-start gap-3 rounded-md border border-border p-3">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <label htmlFor={id} className="min-w-0 flex-1 space-y-1 text-sm">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{offer.title}</span>
          {offer.qualifies ? (
            <span className="flex flex-wrap items-center gap-1.5 text-sm">
              {BigInt(goods) > 0n ? (
                <span>
                  −<Money poisha={goods} locale={locale} />
                </span>
              ) : null}
              {BigInt(delivery) > 0n ? (
                <span className="text-xs text-muted-foreground">
                  {t('oe.offers.freeDelivery')} −<Money poisha={delivery} locale={locale} />
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <StatusBadge tone="neutral">
            {offer.method === 'code' && offer.code !== null ? offer.code : t('oe.offers.automatic')}
          </StatusBadge>
          <span>{offer.allowStacking ? t('oe.offers.combines') : t('oe.offers.alone')}</span>
        </span>
        {offer.description === '' ? null : (
          <span className="block text-xs text-muted-foreground">{offer.description}</span>
        )}
        {offer.qualifies ? null : (
          <span className="block text-xs text-destructive">{t(reasonKey)}</span>
        )}
      </label>
    </li>
  );
}
