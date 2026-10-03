import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Lock, RotateCw, type LucideIcon } from 'lucide-react';

import { cn } from '../lib/cn.js';

/**
 * The four states §24 asks to be *designed* rather than left to happen.
 *
 * Loading, empty, error and permission-denied. Every one of them is a screen a
 * user will actually see, and the default for each — a blank area, a console
 * error, a silently missing panel — is the thing that makes software feel
 * unfinished however good the happy path looks. The client asked for premium and
 * restrained; this is most of where that is won or lost.
 *
 * They live in the kit rather than in each module's screens for one reason: a
 * module that has to build its own empty state will build a different one, and
 * eleven different empty states is the opposite of a design system.
 */

interface StateProps {
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
  readonly className?: string;
  /**
   * A lucide icon that names what is missing (a box for stock, a receipt for orders).
   * Optional: the default is a quiet inbox. Never an illustration, never an emoji (D-440).
   */
  readonly icon?: LucideIcon;
}

/** The icon, set in a small tinted tile: the one mark an empty or error state carries. */
function StateIcon({
  icon: Icon,
  tone = 'neutral',
}: {
  readonly icon: NonNullable<StateProps['icon']>;
  readonly tone?: 'neutral' | 'danger';
}) {
  return (
    <span
      className={cn(
        'flex size-10 items-center justify-center rounded-lg',
        tone === 'danger'
          ? 'bg-destructive-subtle text-destructive-subtle-foreground'
          : 'bg-muted text-muted-foreground',
      )}
    >
      <Icon aria-hidden className="size-5" />
    </span>
  );
}

/**
 * Nothing here yet — and *why*, plus what to do about it.
 *
 * An empty table that says only "No results" is indistinguishable from a broken
 * filter, so the detail line is not decoration: it is the difference between a
 * user clearing a filter and a user filing a bug.
 */
export function EmptyState({ title, detail, action, className, icon = Inbox }: StateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-border px-6 py-14 text-center',
        className,
      )}
    >
      <StateIcon icon={icon} />
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      {detail !== undefined && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p>
      )}
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * Something failed, and the user can retry.
 *
 * Deliberately does **not** render the error message by default. A raw message
 * is either meaningless to the reader or, worse, a leak — an exception text
 * routinely quotes the row that caused it, and this component would be rendering
 * it into a browser belonging to whichever role happened to be looking. The
 * caller passes a `detail` it has decided is safe to show.
 */
export function ErrorState({ title, detail, action, className, icon = AlertTriangle }: StateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-border px-6 py-14 text-center',
        className,
      )}
      role="alert"
    >
      <StateIcon icon={icon} tone="danger" />
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      {detail !== undefined && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p>
      )}
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * The state §24 names and most applications skip.
 *
 * A role that may not see a panel gets *this*, not a blank space and not a
 * crash. The distinction matters to the person using it: a missing panel looks
 * like a bug they should report, while "you do not have permission" is an answer
 * they can act on — by asking someone, rather than by filing a ticket against
 * the software.
 *
 * It is the visible half of `PermissionGate`. The gate's default is to render
 * nothing at all, because most denied things should simply be absent from the
 * page; this is for the cases where absence would be confusing.
 */
export function PermissionDeniedState({ title, detail, className, icon = Lock }: StateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-border px-6 py-14 text-center',
        className,
      )}
    >
      <StateIcon icon={icon} />
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      {detail !== undefined && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}

/**
 * Loading, as a shape rather than a spinner.
 *
 * A skeleton the size of the content it replaces keeps the layout from jumping
 * when data lands, which is most of what makes an interface feel settled. A
 * centred spinner tells the user nothing about what is coming and guarantees a
 * reflow when it does.
 */
export function Skeleton({ className }: { readonly className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      aria-hidden
      data-slot="skeleton"
    />
  );
}

/** A spinner, for the places where a skeleton cannot know the shape. */
export function Spinner({
  className,
  label,
}: {
  readonly className?: string;
  readonly label: string;
}) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex', className)}>
      <RotateCw
        aria-hidden
        className="size-4 motion-safe:animate-spin motion-reduce:animate-none"
      />
    </span>
  );
}
