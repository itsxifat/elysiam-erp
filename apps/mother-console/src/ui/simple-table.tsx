import type { ReactNode } from 'react';

/** A small read-only table in a card: a caption for screen readers, numbers right-aligned. */
export function SimpleTable({
  caption,
  head,
  rows,
  empty,
}: {
  readonly caption: string;
  readonly head: readonly string[];
  readonly rows: readonly { readonly key: string; readonly cells: readonly ReactNode[] }[];
  readonly empty?: string;
}) {
  if (rows.length === 0 && empty !== undefined) {
    return <p className="px-5 pb-5 text-sm text-muted-foreground">{empty}</p>;
  }
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
                className={
                  index === 0
                    ? 'px-5 py-2 text-left font-medium'
                    : 'px-3 py-2 text-right font-medium last:pr-5'
                }
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
                <td
                  key={index}
                  className={
                    index === 0
                      ? 'px-5 py-2 text-left'
                      : 'px-3 py-2 text-right tabular-nums last:pr-5'
                  }
                >
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
