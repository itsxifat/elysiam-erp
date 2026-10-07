import { cn, Input, Label } from '@elysium/ui';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';

/**
 * The few form pieces the owner console needs, built on the kit's `Input` and `Label`
 * so every colour, radius and focus ring is the kit's (§24).
 */

export interface FieldProps extends ComponentPropsWithRef<'input'> {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
}

export function Field({ label, hint, error, className, id, ...rest }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const described = [hint === undefined ? null : hintId, error === undefined ? null : errorId]
    .filter((value): value is string => value !== null)
    .join(' ');
  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={described === '' ? undefined : described}
        className={className}
        {...rest}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-destructive-subtle-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

export function Alert({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground',
        className,
      )}
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function Notice({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md bg-success-subtle px-3 py-2 text-sm text-success-subtle-foreground',
        className,
      )}
    >
      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
