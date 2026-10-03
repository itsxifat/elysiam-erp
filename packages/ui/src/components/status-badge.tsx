import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A status, as a word with a colour behind it — never as a colour alone.
 *
 * §24's accessibility floor says "a label beside every status colour", and this
 * is where that is enforced rather than remembered. An order desk that showed
 * status as a coloured dot would be unreadable to the roughly one man in twelve
 * with red-green colour blindness, and unreadable in a screenshot pasted into a
 * chat, and unreadable to anyone scanning quickly. The colour is the secondary
 * signal; the word is the message.
 *
 * So `children` is required and there is no icon-only or dot-only variant. The
 * component cannot be used the wrong way because the wrong way does not compile.
 *
 * Tones map to the semantic token families — `success`, `warning`,
 * `destructive`, `info`, `muted` — and the `-subtle` pair is used on purpose: a
 * badge filled with the full `bg-destructive` competes with a primary button for
 * attention on a row that has eleven of them.
 */
const badge = cva(
  cn(
    'inline-flex h-5.5 items-center gap-1.5 rounded-xs px-1.5',
    'text-xs font-medium whitespace-nowrap',
    '[&_svg]:size-3 [&_svg]:shrink-0',
    // The dot: the tone's colour as a 6px mark beside the word (D-444). Hidden when the
    // caller already gave the badge an icon, so a badge never carries two markers.
    "before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:opacity-80 before:content-['']",
    'has-[svg]:before:hidden',
  ),
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        success: 'bg-success-subtle text-success-subtle-foreground',
        warning: 'bg-warning-subtle text-warning-subtle-foreground',
        danger: 'bg-destructive-subtle text-destructive-subtle-foreground',
        info: 'bg-info-subtle text-info-subtle-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface StatusBadgeProps extends VariantProps<typeof badge> {
  /**
   * The label. Required, and that is the point — see the note above.
   *
   * It should already be an i18n value: `.claude/rules/frontend.md` says every
   * user-facing string goes through a key, and a status is one of the strings a
   * Bangla-reading user most needs in Bangla.
   */
  readonly children: ReactNode;
  readonly className?: string;
}

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return <span className={cn(badge({ tone }), className)}>{children}</span>;
}

export { badge as statusBadgeVariants };
