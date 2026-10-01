import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A floating panel anchored to a trigger: the notifications inbox, and any other
 * small surface that should not take the whole screen the way a dialog does.
 *
 * Radix for the behaviour that is easy to get wrong by hand — focus moves into the
 * panel and back to the trigger on close, Escape and an outside click close it,
 * and it stays on screen near an edge — and the tokens for the look: the popover
 * surface, a hairline, and the one shadow a floating layer is allowed (§24).
 */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 8,
  ...props
}: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-lg border border-border bg-popover text-popover-foreground shadow-dialog outline-none',
          'motion-safe:duration-base motion-safe:ease-out',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
