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
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md whitespace-nowrap select-none',
    'text-sm font-medium',
    'motion-safe:duration-fast motion-safe:transition-[background-color,border-color,color,box-shadow] motion-safe:ease-out',
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        /** The one action a screen is for. Ink fill, never a gradient (D-440). */
        primary:
          'bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
        /** A second action that still deserves a fill: a quiet neutral step. */
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-selected active:bg-selected [&_svg]:text-muted-foreground',
        /** The default for everything else: a hairline edge on the page. */
        outline:
          'border border-input bg-background text-foreground hover:bg-accent active:bg-selected [&_svg]:text-muted-foreground',
        /** Chrome and row actions: no edge until you point at it. */
        ghost:
          'bg-transparent text-foreground hover:bg-accent active:bg-selected [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground',
        destructive:
          'bg-destructive text-destructive-foreground hover:opacity-90 active:opacity-100',
        /** An inline action that reads as a link but behaves as a button. */
        link: 'h-auto bg-transparent px-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-control-sm gap-1.5 px-2.5 text-sm',
        md: 'h-control px-3.5',
        lg: 'h-control-lg px-4',
        /** Icon-only. The caller must still pass an accessible name (§24). */
        icon: 'h-control w-control p-0',
        /** Icon-only, compact: toolbars and row actions. */
        'icon-sm': 'h-control-sm w-control-sm p-0',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
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
