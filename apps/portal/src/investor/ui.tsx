import { Button, cn, controlClassName, type ButtonProps } from '@elysium/ui';
import { AlertCircle, Loader2 } from 'lucide-react';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * The few pieces the investor portal draws that the kit in `packages/ui` does not have as
 * one component: a labelled field with its hint and error wired to it, an alert, a section
 * with a heading and a caption, and a plain table. Every colour, radius and size is a token
 * class; nothing here picks a palette value (§24, D-033).
 */

export const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, className = '', ...rest },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className={cn(
          controlClassName,
          'h-control-lg w-full text-base',
          error === undefined ? '' : 'border-destructive',
          className,
        )}
        {...rest}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
});

export function Alert({ children }: { readonly children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** A full-width primary action that shows it is working and cannot be pressed twice. */
export function SubmitButton({
  busy,
  children,
  disabled,
  ...rest
}: ButtonProps & { readonly busy: boolean }) {
  return (
    <Button
      type="submit"
      size="lg"
      className="w-full"
      disabled={disabled === true || busy}
      {...rest}
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      ) : null}
      {children}
    </Button>
  );
}

export function Section({
  title,
  caption,
  children,
  aside,
}: {
  readonly title: string;
  readonly caption: string;
  readonly children: ReactNode;
  readonly aside?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-0.5">
          <h2 id={id} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{caption}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export interface Column<Row> {
  readonly header: string;
  readonly numeric?: boolean;
  readonly cell: (row: Row) => ReactNode;
}

/**
 * A read-only table. Small on purpose: an investor's lists are a few rows a month, with no
 * sorting, paging or column picking to offer, so the kit's `DataTable` would be machinery
 * with nothing to do. Scrolls sideways inside its own frame on a phone rather than pushing
 * the page wider — and that frame is a named, focusable region, so someone on a keyboard
 * can scroll it too (axe's `scrollable-region-focusable`, found by the phone-width run).
 */
export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  readonly caption: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
}) {
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={cn('overflow-x-auto rounded-lg border border-border bg-card', FOCUS)}
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-muted-foreground">
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={cn(
                  'h-10 px-4 text-xs font-medium whitespace-nowrap',
                  column.numeric === true ? 'text-right' : 'text-left',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-t border-border hover:bg-accent/60 motion-safe:transition-colors"
            >
              {columns.map((column) => (
                <td
                  key={column.header}
                  className={cn(
                    'h-row px-4 whitespace-nowrap',
                    column.numeric === true ? 'text-right tabular-nums' : 'text-left',
                  )}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
