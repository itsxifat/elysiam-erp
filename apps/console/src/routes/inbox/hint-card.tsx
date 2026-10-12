import { Button, cn } from '@elysium/ui';
import type { SizeRecommendation } from '@elysium/domain/inbox';
import { Plus, Search, Sparkles, X } from 'lucide-react';
import { useId, type KeyboardEvent, type RefObject } from 'react';

import '../../alive/alive.css';
import { displayPhone } from './logic.js';
import type { PickerProduct, SizeChart } from './sell-api.js';
import { measureParts, refQuery, type CardRead } from './sell-logic.js';
import { useSellT } from './sell-messages.js';

export interface HintCardProps {
  readonly read: CardRead;
  /** The product the card's size applies to: the one linked, else the one last picked. */
  readonly target: PickerProduct | null;
  readonly chart: SizeChart | undefined;
  readonly recommendation: SizeRecommendation | null;
  /** An address found in the chat while the draft has none: "Mirpur, Dhaka". */
  readonly place: string | null;
  readonly onAdd: () => void;
  readonly onChoose: () => void;
  readonly onDismiss: () => void;
  readonly cardRef: RefObject<HTMLDivElement | null>;
}

/**
 * The side card (M44b, D-770, D-771): what the customer's newest messages ask for, offered in one
 * line ("Size XL · Qty 2 · Chest 42 in → L (from the Panjabi size chart)") with Add to draft,
 * Choose the product and Dismiss. It slides in at the top of the panel when a new message carries
 * something, and changes as more arrive. Focused, Enter adds and Esc dismisses; Alt+A adds from
 * anywhere on the page. It never takes the focus itself: an agent typing a reply keeps typing.
 */
export function HintCard({
  read,
  target,
  chart,
  recommendation,
  place,
  onAdd,
  onChoose,
  onDismiss,
  cardRef,
}: HintCardProps) {
  const t = useSellT();
  const ids = useId();
  const summary = read.summary;

  const facts: string[] = [];
  if (summary.size !== null) facts.push(t('inbox.sell.card.size', { size: summary.size.size }));
  if (summary.quantity !== null) {
    facts.push(t('inbox.sell.card.qty', { qty: String(summary.quantity.qty) }));
  }
  if (summary.colour !== null) facts.push(summary.colour.colour);
  for (const measure of summary.measurements) {
    const parts = measureParts(measure);
    const words = `${t(`inbox.sell.part.${measure.part}`)} ${t(parts.key, parts.values)}`;
    const fit = recommendation?.fits.find((entry) => entry.part === measure.part);
    if (target === null) facts.push(t('inbox.sell.card.needProduct', { measure: words }));
    else if (target.sizeChartId === null)
      facts.push(t('inbox.sell.card.noChart', { measure: words }));
    else if (chart === undefined || fit === undefined) facts.push(words);
    else if (fit.reason === 'above_chart') {
      facts.push(t('inbox.sell.card.overChart', { measure: words, chart: chart.name }));
    } else if (fit.size === null) facts.push(words);
    else {
      facts.push(
        t('inbox.sell.card.recommend', { measure: words, size: fit.size, chart: chart.name }),
      );
    }
  }
  for (const product of summary.products) {
    facts.push(t('inbox.sell.card.product', { ref: refQuery(product.ref) }));
  }
  if (read.phone !== null)
    facts.push(t('inbox.sell.card.phone', { phone: displayPhone(read.phone) }));
  if (place !== null) facts.push(t('inbox.sell.card.address', { place }));

  const sources = [
    ...new Set(
      [summary.size, summary.quantity, summary.colour, ...summary.measurements, ...summary.products]
        .filter((hint) => hint !== null)
        .map((hint) => hint.source.trim()),
    ),
  ].slice(0, 4);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      onAdd();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
    }
  };

  return (
    <div
      ref={cardRef}
      tabIndex={0}
      role="group"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-facts ${ids}-keys`}
      onKeyDown={onKey}
      className={cn(
        'space-y-2 rounded-lg border border-ring/50 bg-card p-3 shadow-popover',
        'alive-in',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      )}
    >
      <p
        id={`${ids}-title`}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase"
      >
        <Sparkles aria-hidden className="size-3.5" />
        {t('inbox.sell.card.label')}
      </p>
      <p id={`${ids}-facts`} className="text-sm font-medium break-words">
        {facts.join(' · ')}
      </p>
      {target === null ? null : (
        <p className="truncate text-xs text-muted-foreground">
          {t('inbox.sell.card.for', { product: target.name })}
        </p>
      )}
      {sources.length === 0 ? null : (
        <p className="truncate text-xs text-muted-foreground">
          {sources.map((source) => `“${source}”`).join(' ')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onAdd}>
          <Plus aria-hidden className="size-4" />
          {t('inbox.sell.card.add')}
        </Button>
        <Button size="sm" variant="outline" onClick={onChoose}>
          <Search aria-hidden className="size-4" />
          {t('inbox.sell.card.choose')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          aria-label={t('inbox.sell.card.dismiss')}
        >
          <X aria-hidden className="size-4" />
          {t('inbox.sell.card.dismiss')}
        </Button>
      </div>
      <p id={`${ids}-keys`} className="text-xs text-muted-foreground">
        {t('inbox.sell.card.keys')}
      </p>
    </div>
  );
}
