import { cn } from '@elysium/ui';
import type { ReactNode } from 'react';

/**
 * A small read-only table in a card: a caption for screen readers, words left-aligned and
 * numbers right-aligned in tabular figures (§24).
 */
export function SimpleTable({
  caption,
  head,
  numeric = [],
  rows,
  empty,
}: {
  readonly caption: string;
  readonly head: readonly string[];
  /** Which columns hold numbers or money, by index. */
  readonly numeric?: readonly number[];
  readonly rows: readonly { readonly key: string; readonly cells: readonly ReactNode[] }[];
  readonly empty?: string;
}) {
  if (rows.length === 0 && empty !== undefined) {
    return <p className="px-5 pb-5 text-sm text-muted-foreground">{empty}</p>;
  }
  const edge = (index: number) =>
    cn(index === 0 ? 'pl-5' : 'pl-3', index === head.length - 1 ? 'pr-5' : 'pr-3');
  const align = (index: number) =>
    numeric.includes(index) ? 'text-right tabular-nums' : 'text-left';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-y border-border text-xs text-muted-foreground">
            {head.map((label, index) => (
              <th
                key={label}
                scope="col"
                className={cn('py-2 font-medium', edge(index), align(index))}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-0">
              {row.cells.map((cell, index) => (
                <td key={index} className={cn('py-2', edge(index), align(index))}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
