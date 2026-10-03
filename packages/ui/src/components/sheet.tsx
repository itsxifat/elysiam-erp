import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from './button.js';
import { cn } from '../lib/cn.js';

/**
 * A panel that slides in from the side (D-447): quick create and quick edit, where a
 * full page is too much and a centred dialog too cramped. The page stays visible
 * behind it, so the person keeps their place in the list they came from.
 *
 * The same Radix dialog as `Dialog`, so the focus trap, Escape and focus restore are
 * the proven ones. The footer sticks to the bottom: a long form never hides its Save.
 */
export interface SheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  /** The action row, pinned to the bottom edge. Primary last. */
  readonly footer?: ReactNode;
  readonly closeLabel: string;
  readonly side?: 'right' | 'left';
  /** `md` is a form's width; `lg` for a detail with a table in it. */
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel,
  side = 'right',
  size = 'md',
  className,
}: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay motion-safe:animate-fade" />
        <DialogPrimitive.Content
          className={cn(
            'fixed inset-y-2 z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-dialog focus-visible:outline-none',
            side === 'right'
              ? 'right-2 motion-safe:animate-sheet-in'
              : 'left-2 motion-safe:animate-drawer-in',
            size === 'sm' && 'w-[min(24rem,calc(100vw-1rem))]',
            size === 'md' && 'w-[min(32rem,calc(100vw-1rem))]',
            size === 'lg' && 'w-[min(44rem,calc(100vw-1rem))]',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
            <div className="space-y-1">
              <DialogPrimitive.Title className="text-base font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              {description === undefined ? null : (
                <DialogPrimitive.Description className="text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label={closeLabel} className="-mr-2">
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer === undefined ? null : (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-canvas px-6 py-3">
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
