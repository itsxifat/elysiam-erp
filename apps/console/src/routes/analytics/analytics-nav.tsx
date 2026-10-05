import { PageHeader, cn, controlClassName } from '@elysium/ui';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

export function AnalyticsHeader({
  title,
  caption,
  actions,
}: {
  readonly title: string;
  readonly caption: string;
  readonly actions?: ReactNode;
}) {
  // One screen since M31 (D-471), so no tabs: the brand's own dashboard.
  return (
    <PageHeader
      title={title}
      description={caption}
      {...(actions === undefined ? {} : { actions })}
    />
  );
}

/** A titled block with a hairline border, the frame every table on these screens sits in. */
export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-card">
      <h2 className="px-4 pt-4 pb-3 text-base font-semibold tracking-tight">{title}</h2>
      <ScrollFrame label={title}>{children}</ScrollFrame>
    </section>
  );
}

/**
 * A table's horizontal scroll, reachable by keyboard when it scrolls (WCAG 2.1.1): a
 * read-only table has nothing focusable, so the frame itself becomes the tab stop.
 */
function ScrollFrame({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const measure = () => setScrollable(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild !== null) observer?.observe(element.firstElementChild);
    return () => observer?.disconnect();
  }, []);
  return (
    <div
      ref={frame}
      {...(scrollable ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})}
      className="overflow-x-auto rounded-b-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </div>
  );
}

/** One figure with its label: the dashboard's tiles. */
export function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
}) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-medium tabular-nums">{value}</p>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A translated sentence with `{name}` placeholders filled by nodes — a `<Money>` where the
 * value is an amount, so money in a sentence is formatted like money everywhere else.
 */
export function Template({
  text,
  values,
}: {
  readonly text: string;
  readonly values: Readonly<Record<string, ReactNode>>;
}) {
  const parts = text.split(/(\{[a-zA-Z]+\})/);
  return (
    <>
      {parts.map((part, index) => {
        const name = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1];
        const value = name === undefined ? undefined : values[name];
        return <Fragment key={index}>{value ?? part}</Fragment>;
      })}
    </>
  );
}

export const CELL = 'h-row border-t border-border px-4 text-left whitespace-nowrap';
export const NUMERIC =
  'h-row border-t border-border px-4 text-right tabular-nums whitespace-nowrap';
export const HEAD =
  'h-9 px-4 text-left text-xs font-medium whitespace-nowrap text-muted-foreground';
export const HEAD_NUMERIC =
  'h-9 px-4 text-right text-xs font-medium whitespace-nowrap text-muted-foreground';
/** The kit's control chrome at the small height, for the date pickers in a header. */
export const INPUT = cn(controlClassName, 'h-control-sm px-2.5 tabular-nums');
export const BUTTON =
  'inline-flex h-control-sm items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-sm font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 [&_svg]:text-muted-foreground';
