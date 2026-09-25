import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * The button, re-tuned to the tokens rather than left at shadcn's defaults.
 *
 * `.claude/rules/frontend.md` is explicit that adopting a shadcn component means
 * re-tuning it, and the reason is what the client asked for: dropping the
 * library in unmodified produces a competent generic application, which is the
 * opposite of "premium and restrained". Every value below resolves to a token —
 * `bg-primary`, `h-control`, `rounded-md`, `duration-fast` — so light and dark
 * stay in step by construction (check 8) and an org's accent (D-034) repaints
 * without a rebuild.
 *
 * Three things are deliberate:
 *
 * - **Focus is never removed.** `focus-visible:ring-2` on top of the global
 *   `:focus-visible` outline, because a button inside a dark surface needs the
 *   offset to read. The order desk is driven by keyboard (§24) and an invisible
 *   focus ring makes it unusable.
 * - **Motion honours `prefers-reduced-motion`.** `motion-safe:` on the
 *   transition, so someone who has asked the OS to stop animating gets a button
 *   that changes state instantly rather than one that ignores them.
 * - **`destructive` is a variant, not a colour prop.** Colour means danger here,
 *   never decoration, and a `color` prop is how `bg-red-500` ends up on a Save
 *   button.
 */
const button = cva(
  cn(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md whitespace-nowrap',
    'text-sm font-medium',
    'motion-safe:duration-fast motion-safe:transition-colors motion-safe:ease-out',
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-muted',
        outline: 'border border-border bg-transparent hover:bg-muted',
        ghost: 'bg-transparent hover:bg-muted',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
      },
      size: {
        sm: 'h-control-sm px-2.5',
        md: 'h-control px-3',
        lg: 'h-control-lg px-4',
        /** Icon-only. The caller must still pass an accessible name (§24). */
        icon: 'h-control w-control p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  readonly children?: ReactNode;
}

export function Button({ className, variant, size, type = 'button', ...rest }: ButtonProps) {
  // `type="button"` by default. The HTML default is `submit`, so a button placed
  // in a form to open a dialog submits the form instead — a bug that looks like
  // a routing problem and is found by a user, not a test.
  return <button type={type} className={cn(button({ variant, size }), className)} {...rest} />;
}

export { button as buttonVariants };
