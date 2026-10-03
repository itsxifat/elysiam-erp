import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Join class names, with later Tailwind utilities winning over earlier ones.
 *
 * `clsx` handles the conditionals; `twMerge` resolves the conflicts. Without the
 * second half, `cn('px-4', 'px-2')` emits both and which one applies depends on
 * the order Tailwind happened to generate them in — so a component's own padding
 * would sometimes beat the caller's override and sometimes not, per class, per
 * build. That is the bug that gets "fixed" with `!important` and then stays
 * forever.
 */
/**
 * The preset's own scale names (tailwind.css `@theme`), taught to the merger. Without
 * them `h-control` and `h-control-sm` were not seen as one property, so a caller's
 * `size` override and a component's default both stayed in the class string and the
 * stylesheet's order picked the winner (found by the design refresh's till work).
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: [
        'row',
        'control',
        'control-sm',
        'control-lg',
        'sidebar',
        'sidebar-collapsed',
        'topbar',
      ],
      container: ['form', 'page'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
