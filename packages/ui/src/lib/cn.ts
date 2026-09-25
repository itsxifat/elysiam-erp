import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
