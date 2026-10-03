import { Search, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { controlClassName, type InputProps } from './input.js';
import { cn } from '../lib/cn.js';

/**
 * The filter toolbar's two pieces besides the selects (D-443): a search box with its
 * icon, and the chips that say which filters are on.
 */

export type SearchInputProps = Omit<InputProps, 'type'> & {
  /** Rendered as a clear button inside the field once there is text. */
  readonly onClear?: () => void;
  readonly clearLabel?: string;
};

export function SearchInput({ className, onClear, clearLabel, value, ...rest }: SearchInputProps) {
  const hasValue = typeof value === 'string' ? value !== '' : value !== undefined;
  return (
    <div className={cn('relative w-full sm:w-72', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        {...(value === undefined ? {} : { value })}
        className={cn(
          controlClassName,
          'pl-9 [&::-webkit-search-cancel-button]:hidden',
          onClear !== undefined && 'pr-8',
        )}
        {...rest}
      />
      {onClear !== undefined && hasValue ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export interface ActiveFilter {
  readonly key: string;
  /** "Status", the filter's name. */
  readonly label: string;
  /** "Delivered", what it is set to. */
  readonly value: ReactNode;
  readonly onRemove: () => void;
}

/**
 * The filters that are narrowing the list, as chips with a remove button each, and
 * one "Clear all". Nothing renders when no filter is on, so an unfiltered list has
 * no empty row of chrome above it.
 */
export function FilterChips({
  filters,
  onClearAll,
  removeLabel,
  clearAllLabel,
  className,
}: {
  readonly filters: readonly ActiveFilter[];
  readonly onClearAll?: () => void;
  /** "Remove filter", prefixed to the filter's name for the remove button's name. */
  readonly removeLabel: string;
  readonly clearAllLabel?: string;
  readonly className?: string;
}) {
  if (filters.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {filters.map((filter) => (
        <span
          key={filter.key}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-selected pr-1 pl-2.5 text-xs text-selected-foreground"
        >
          <span className="text-muted-foreground">{filter.label}:</span>
          <span className="font-medium">{filter.value}</span>
          <button
            type="button"
            onClick={filter.onRemove}
            aria-label={`${removeLabel}: ${filter.label}`}
            className="ml-0.5 flex size-5 items-center justify-center rounded-xs text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      {onClearAll === undefined || clearAllLabel === undefined || filters.length < 2 ? null : (
        <button
          type="button"
          onClick={onClearAll}
          className="h-7 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {clearAllLabel}
        </button>
      )}
    </div>
  );
}
