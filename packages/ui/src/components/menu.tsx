import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A menu of actions (D-445): a page's secondary actions behind one "More" button,
 * a row's actions, the account menu.
 *
 * Radix for the menu semantics (arrow keys, typeahead, Escape, focus return) that a
 * hand-made list of buttons never quite gets. Items are actions, not navigation; a
 * link in a menu goes through `asChild` on the item.
 */

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;

export function MenuContent({
  className,
  align = 'end',
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-popover',
          'motion-safe:animate-in',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function MenuItem({
  className,
  destructive = false,
  shortcut,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
  readonly destructive?: boolean;
  readonly shortcut?: ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'relative flex h-control-sm cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm outline-none select-none',
        'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        destructive &&
          'text-destructive-subtle-foreground data-highlighted:bg-destructive-subtle data-highlighted:text-destructive-subtle-foreground [&_svg]:text-current',
        className,
      )}
      {...props}
    >
      {children}
      {shortcut === undefined ? null : (
        <span className="ml-auto pl-4 text-xs text-muted-foreground">{shortcut}</span>
      )}
    </MenuPrimitive.Item>
  );
}

export function MenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cn('px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
  );
}
