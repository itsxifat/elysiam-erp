import { AlertCircle, Loader2 } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

/**
 * The smallest set of controls the login flow needs (architecture §24, D-033).
 *
 * Provisional: M05 builds the real shadcn/ui kit in `packages/ui`, and these go
 * away when it lands. They exist now because M02a ships a screen, and a screen
 * built out of raw `<input>` elements would not meet the focus-ring and
 * contrast rules the design system exists to hold.
 *
 * Every value below is a semantic token. There is no palette colour, no literal
 * radius and no literal duration anywhere in this file, which is what the
 * ESLint rule in packages/config checks.
 */

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: 'primary' | 'ghost' | 'link';
  readonly busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', busy = false, className = '', children, disabled, ...rest },
  ref,
) {
  const base = `inline-flex h-(--control-height) items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors ${FOCUS_RING} disabled:pointer-events-none disabled:opacity-60`;

  const variants = {
    primary:
      'w-full bg-primary px-4 text-primary-foreground hover:bg-primary-hover active:bg-primary-active',
    ghost: 'px-3 text-foreground hover:bg-accent hover:text-accent-foreground',
    link: 'h-auto px-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline',
  } as const;

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled === true || busy}
      className={`${base} ${variants[variant]} ${className}`}
      {...rest}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
});

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, id, className = '', ...rest },
  ref,
) {
  const fieldId = id ?? rest.name ?? label;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;

  const describedBy = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <input
        ref={ref}
        id={fieldId}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className={`h-(--control-height) w-full rounded-md border bg-background px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground ${FOCUS_RING} ${
          error === undefined ? 'border-input' : 'border-destructive'
        } ${className}`}
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

/** A placeholder shaped like the content it stands in for (frontend rules). */
export function Skeleton({ className = '' }: { readonly className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-muted motion-reduce:animate-none ${className}`}
    />
  );
}

/**
 * An error the user must read.
 *
 * `role="alert"` rather than a styled div: a sign-in failure announced only by
 * colour is invisible to a screen reader and to anyone who cannot distinguish
 * the hue, which is the same accessibility floor §24 sets for status badges.
 */
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
