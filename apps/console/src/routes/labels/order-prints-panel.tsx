import { DateTime } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';

import { useT } from '../../i18n/locale.js';
import { orderPrints, type PrintTally } from './api.js';
import { lotText } from './parts.js';

/**
 * The order page's print record (M46, D-818): each lot's label and slip, how many times each
 * printed, and the newest — "Printed 3 times, last 17 Oct 14:02 by Rahim at Label 1" — and when
 * each lot went to the courier. Shown once anything printed or the order goes in several lots.
 */
export function OrderPrintsPanel({ orderId }: { readonly orderId: string }) {
  const t = useT();
  const id = useId();
  const prints = useQuery({
    queryKey: ['labels', 'order', orderId],
    queryFn: () => orderPrints(orderId),
    retry: false,
  });
  const data = prints.data;
  if (data === undefined) return null;
  if (data.history.length === 0 && data.lotCount <= 1) return null;
  return (
    <section
      aria-labelledby={id}
      data-testid="order-prints"
      className="space-y-3 rounded-lg border border-border bg-card p-5 text-sm"
    >
      <h2 id={id} className="text-base font-semibold tracking-tight">
        {t('lb.labels.title')}
      </h2>
      <ul className="divide-y divide-border">
        {data.lots.map((lot) => (
          <li key={lot.lot} className="space-y-1 py-2">
            {data.lotCount > 1 ? (
              <p className="font-medium">{lotText(t, lot.lot, data.lotCount)}</p>
            ) : null}
            <Tally label={t('lb.doc.label')} tally={lot.label} />
            <Tally label={t('lb.doc.packing_slip')} tally={lot.slip} />
            {lot.handedAt === null ? null : (
              <p className="text-xs text-muted-foreground">
                {`${t('lb.handover.done')}: `}
                <DateTime value={lot.handedAt} />
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tally({ label, tally }: { readonly label: string; readonly tally: PrintTally }) {
  const t = useT();
  return (
    <p>
      <span className="text-muted-foreground">{`${label}: `}</span>
      {tally.count === 0 ? (
        '—'
      ) : (
        <>
          {`${t('lb.job.printed')} ${String(tally.count)}×`}
          {tally.last === null ? null : (
            <span className="text-muted-foreground">
              {' · '}
              <DateTime value={tally.last.at} />
              {` · ${tally.last.auto ? t('lb.source.auto') : (tally.last.by ?? '')}`}
              {tally.last.terminal === null ? '' : ` · ${tally.last.terminal}`}
            </span>
          )}
        </>
      )}
    </p>
  );
}
