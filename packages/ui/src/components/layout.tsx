import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * The page's frame (D-445): a header, sections, cards, tabs, a toolbar.
 *
 * Every module built its own header and its own "titled box" before the design
 * refresh, so the console had a dozen near-identical ones that each drifted by a
 * pixel or a weight. These are the one spelling. They are plain elements with
 * token classes: no state, no library, nothing that costs the bundle.
 */

export interface PageHeaderProps {
  readonly title: ReactNode;
  /** One short sentence: what this page is for. */
  readonly description?: ReactNode;
  /**
   * The primary action, right-aligned, and at most a menu of secondary ones beside it.
   * One obvious thing to do per page (D-440).
   */
  readonly actions?: ReactNode;
  /** Above the title: a back link or the section the page sits in. */
  readonly eyebrow?: ReactNode;
  /** Beside the title: a status badge, a live indicator. */
  readonly meta?: ReactNode;
  /** Below the header: the section's tabs. */
  readonly tabs?: ReactNode;
  readonly className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  meta,
  tabs,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('space-y-5', className)}>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1">
          {eyebrow === undefined ? null : (
            <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
            {meta}
          </div>
          {description === undefined ? null : (
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </header>
      {tabs}
    </div>
  );
}

/**
 * Section tabs, as links (each tab is a route, so a tab is shareable and Back works).
 *
 * The kit cannot import the router, so it ships the classes and the frame; each
 * section's nav renders its own `<Link className={tabClassName}
 * activeProps={{ className: tabActiveClassName }}>`. An underline on a hairline,
 * the way a document's sections read, rather than a row of pills.
 */
export const tabClassName = cn(
  'relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-1 text-sm whitespace-nowrap text-muted-foreground',
  'motion-safe:duration-fast hover:text-foreground motion-safe:transition-colors',
  'focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
  // The router marks the active link `aria-current="page"`; styling from that keeps the
  // look and the announced state from disagreeing.
  'aria-[current=page]:border-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground',
);
/** Kept for the router's `activeProps`; the active look itself comes from `aria-current`. */
export const tabActiveClassName = 'font-medium text-foreground';

export function TabList({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        'flex [scrollbar-width:none] gap-5 overflow-x-auto border-b border-border',
        className,
      )}
    >
      {children}
    </nav>
  );
}

/**
 * A titled region of a page. Not every block needs a box: `variant="plain"` is a
 * heading and its content on the page itself; `card` puts it on a surface with a
 * hairline, for a table or a list that needs an edge.
 */
export function Section({
  title,
  description,
  actions,
  children,
  variant = 'card',
  className,
  bodyClassName,
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly variant?: 'card' | 'plain';
  readonly className?: string;
  readonly bodyClassName?: string;
}) {
  const head =
    title === undefined && actions === undefined ? null : (
      <div
        className={cn(
          'flex flex-wrap items-start justify-between gap-3',
          variant === 'card' ? 'px-5 pt-4 pb-3' : 'pb-3',
        )}
      >
        <div className="min-w-0 space-y-0.5">
          {title === undefined ? null : (
            <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
          )}
          {description === undefined ? null : (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
      </div>
    );

  return (
    <section
      className={cn(
        variant === 'card' && 'rounded-lg border border-border bg-card text-card-foreground',
        className,
      )}
    >
      {head}
      <div className={cn(variant === 'card' && head !== null && 'px-5 pb-5', bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

/** A surface with a hairline: the one card. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-border bg-card text-card-foreground', className)}
      {...rest}
    />
  );
}

/** A filter row: controls on the left, the rest pushed right. Wraps on a narrow screen. */
export function Toolbar({
  children,
  end,
  className,
}: {
  readonly children: ReactNode;
  readonly end?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {children}
      {end === undefined ? null : <div className="ml-auto flex items-center gap-2">{end}</div>}
    </div>
  );
}

/** A keyboard key, as printed in a hint or a menu: `Ctrl`, `K`. */
export function Kbd({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-border bg-background px-1 font-sans text-2xs font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * A tooltip in CSS: shown on hover and on keyboard focus of the wrapped control.
 *
 * Not a Radix tooltip, on purpose. The shell's icon buttons need one, and the shell
 * is the initial bundle, where a positioning engine costs more than the whole
 * budget's headroom. The tip repeats the control's accessible name (and its
 * shortcut), so it is `aria-hidden`: the name is already announced once.
 */
export function Hint({
  label,
  shortcut,
  side = 'bottom',
  children,
  className,
}: {
  readonly label: string;
  readonly shortcut?: ReactNode;
  readonly side?: 'bottom' | 'top' | 'right';
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={cn('group/hint relative inline-flex', className)}>
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute z-50 flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1 text-xs font-medium whitespace-nowrap text-background opacity-0 shadow-popover',
          'motion-safe:duration-fast motion-safe:transition-opacity',
          'group-has-[:focus-visible]/hint:opacity-100 [@media(hover:hover)]:group-hover/hint:opacity-100',
          'delay-0 [@media(hover:hover)]:group-hover/hint:delay-300',
          side === 'bottom' && 'top-full left-1/2 mt-1.5 -translate-x-1/2',
          side === 'top' && 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
          side === 'right' && 'top-1/2 left-full ml-2 -translate-y-1/2',
        )}
      >
        {label}
        {shortcut === undefined ? null : (
          <span className="text-2xs font-medium opacity-70">{shortcut}</span>
        )}
      </span>
    </span>
  );
}

/**
 * Initials in a tinted square: a brand in the switcher, a person in the user menu.
 * Never a photo the system does not have, never a generated avatar.
 */
export function Monogram({
  name,
  size = 'md',
  tone = 'neutral',
  className,
}: {
  readonly name: string;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly tone?: 'neutral' | 'brand';
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-semibold tracking-tight select-none',
        size === 'sm' && 'size-6 text-2xs',
        size === 'md' && 'size-7 text-xs',
        size === 'lg' && 'size-9 text-sm',
        tone === 'brand'
          ? 'bg-primary text-primary-foreground'
          : 'bg-selected text-selected-foreground',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

/** "Acme Lifestyle BD" is AL; "Orbit" is OR; a Bangla name keeps its first letter. */
export function initials(name: string): string {
  // Words that start with a letter or digit only: "(preview seed)" is not a name.
  const words = name
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter((word) => word !== '');
  const first = words[0] ?? '';
  if (words.length === 1) return Array.from(first).slice(0, 2).join('').toUpperCase();
  const second = words[1] ?? '';
  return `${Array.from(first)[0] ?? ''}${Array.from(second)[0] ?? ''}`.toUpperCase();
}

/** A label and its value, stacked: the facts on a detail page. */
export function DescriptionList({
  items,
  columns = 3,
  className,
}: {
  readonly items: readonly { readonly label: ReactNode; readonly value: ReactNode }[];
  readonly columns?: 2 | 3 | 4;
  readonly className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-8 gap-y-4',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        columns === 4 && 'sm:grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {items.map((item, index) => (
        <div key={index} className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="text-sm font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
