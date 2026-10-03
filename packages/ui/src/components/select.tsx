import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { controlClassName } from './input.js';
import { cn } from '../lib/cn.js';

/**
 * The select, on Radix (D-443): every filter and every choice in a form.
 *
 * It replaces the native `<select>` the console's filters used. The native control
 * is accessible, but its open list is drawn by the operating system: a grey Windows
 * list on a premium screen, in a font and a size the page does not use, with no
 * dark theme. Radix keeps what the native control got right (the listbox role,
 * typeahead, arrow keys, Escape, focus returning to the trigger) and lets the list
 * be drawn with the tokens.
 *
 * The API is the native one, narrowed: a string `value`, an `onValueChange`, and
 * the options as data. That is what made the conversion mechanical, and it keeps
 * the URL-held filters (`''` for "every status") working unchanged: Radix reserves
 * the empty string for "no selection", so it is mapped to a private sentinel on the
 * way in and back to `''` on the way out.
 */

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** A second line, muted: what choosing this means. */
  readonly description?: string;
}

/** Radix may not hold `''`; a filter's "all" option does. */
const EMPTY = '__elysium-empty__';
const toRadix = (value: string): string => (value === '' ? EMPTY : value);
const fromRadix = (value: string): string => (value === EMPTY ? '' : value);

export interface SelectProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  /** Shown when the value matches no option. Required when `''` is not an option. */
  readonly placeholder?: string;
  readonly id?: string;
  /** Submitted with a form, like the native control's `name`. */
  readonly name?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string | undefined;
  readonly 'aria-invalid'?: boolean | undefined;
  readonly 'aria-errormessage'?: string | undefined;
  readonly disabled?: boolean;
  readonly required?: boolean;
  /** On the trigger. Width is the usual reason: filters size to their content. */
  readonly className?: string;
  readonly size?: 'sm' | 'md';
  /**
   * A filter reads as "set" when it is not on its default (`''`): the trigger takes the
   * selected surface, so a glance at a toolbar shows which filters are narrowing the list.
   */
  readonly variant?: 'field' | 'filter';
  /** Rendered before the value inside the trigger, e.g. a lucide icon. */
  readonly leading?: ReactNode;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  id,
  name,
  disabled,
  required,
  className,
  size = 'md',
  variant = 'field',
  leading,
  ...aria
}: SelectProps) {
  const active = variant === 'filter' && value !== '';
  const known = options.some((option) => option.value === value);

  return (
    <SelectPrimitive.Root
      // A value no option carries would leave Radix showing nothing at all; showing the
      // placeholder instead is what the native control did.
      value={known ? toRadix(value) : ''}
      onValueChange={(next) => onValueChange(fromRadix(next))}
      {...(name === undefined ? {} : { name })}
      {...(disabled === true ? { disabled: true } : {})}
      {...(required === true ? { required: true } : {})}
    >
      <SelectPrimitive.Trigger
        {...(id === undefined ? {} : { id })}
        {...aria}
        className={cn(
          controlClassName,
          'inline-flex items-center justify-between gap-2 text-left',
          'data-placeholder:text-muted-foreground',
          '[&>span]:min-w-0 [&>span]:truncate',
          size === 'sm' && 'h-control-sm px-2.5',
          variant === 'filter' && 'w-auto min-w-36',
          active && 'border-ring/50 bg-primary-subtle text-foreground',
          className,
        )}
      >
        {leading === undefined ? null : (
          <span className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-4">
            {leading}
          </span>
        )}
        <span className="flex-1">
          <SelectPrimitive.Value {...(placeholder === undefined ? {} : { placeholder })} />
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} option={option} />
          ))}
        </SelectContent>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/** The floating list. Exported for `SelectField`, which wires the same parts to a form. */
export function SelectContent({ children }: { readonly children: ReactNode }) {
  return (
    <SelectPrimitive.Content
      position="popper"
      sideOffset={6}
      collisionPadding={8}
      className={cn(
        'z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden',
        'rounded-lg border border-border bg-popover text-popover-foreground shadow-popover',
        'motion-safe:animate-in',
      )}
    >
      <SelectPrimitive.Viewport className="max-h-80 p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  );
}

export function SelectItem({ option }: { readonly option: SelectOption }) {
  return (
    <SelectPrimitive.Item
      value={toRadix(option.value)}
      {...(option.disabled === true ? { disabled: true } : {})}
      className={cn(
        'relative flex min-h-control-sm cursor-pointer items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 text-sm outline-none select-none',
        'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        'data-[state=checked]:font-medium',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
      )}
    >
      <span className="min-w-0">
        <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
        {option.description === undefined ? null : (
          <span className="block text-xs font-normal text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex items-center">
        <Check aria-hidden="true" className="size-4 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { SelectPrimitive };
