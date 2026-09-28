import { useId, type ReactNode } from 'react';
import {
  FormProvider,
  useFormContext,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
} from 'react-hook-form';

import { Label } from './input.js';
import { cn } from '../lib/cn.js';

/**
 * The form kit's frame: a field's label, its control, its hint and its error
 * (§24; `.claude/rules/frontend.md` "Forms use React Hook Form with the shared
 * Zod schema from `packages/contracts`").
 *
 * The rule this exists to enforce is that **the error text comes from the Zod
 * schema**, never from the component. A contract already says
 * `'Enter a Bangladeshi mobile number, e.g. 01712345678'`; a field that wrote
 * its own message would produce a second, drifting wording for the same
 * rejection — and the one the user sees would depend on whether the browser or
 * the server caught it first. So `FormField` reads `formState.errors` and
 * renders whatever the resolver put there.
 *
 * The ARIA wiring is the other half, and it is the part that gets skipped: the
 * control is given `aria-describedby` for the hint, `aria-invalid` when it is
 * wrong, and `aria-errormessage` pointing at the message. Without those, a
 * screen-reader user tabs onto a field that is visually red and hears nothing at
 * all — which is the difference between a form that is hard to use and one that
 * cannot be completed.
 */

export interface FieldRenderProps {
  /** Spread onto the control. Carries id and the full ARIA wiring. */
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': boolean | undefined;
  readonly 'aria-errormessage': string | undefined;
}

export interface FormFieldProps<
  TValues extends FieldValues,
  TName extends FieldPath<TValues> = FieldPath<TValues>,
> {
  readonly name: TName;
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly className?: string;
  readonly children: (field: FieldRenderProps) => ReactNode;
}

export function FormField<
  TValues extends FieldValues,
  TName extends FieldPath<TValues> = FieldPath<TValues>,
>({ name, label, hint, required = false, className, children }: FormFieldProps<TValues, TName>) {
  const form = useFormContext<TValues>();
  const generated = useId();

  const controlId = `${generated}-control`;
  const hintId = `${generated}-hint`;
  const errorId = `${generated}-error`;

  // `name.split('.')` rather than `errors[name]`, because react-hook-form nests
  // errors the way the field path nests. A flat lookup silently finds nothing
  // for `lines.0.quantity`, and the field then renders as valid while the form
  // refuses to submit — the worst possible combination.
  const error = errorAt(form.formState.errors, name);

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={controlId} required={required}>
        {label}
      </Label>

      {children({
        id: controlId,
        'aria-describedby': hint === undefined ? undefined : hintId,
        'aria-invalid': error === undefined ? undefined : true,
        'aria-errormessage': error === undefined ? undefined : errorId,
      })}

      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}

      {error === undefined ? null : (
        // `role="alert"` so the message is announced when it appears rather than
        // only when the field is next focused.
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The message at a dotted field path, or undefined. */
function errorAt(errors: unknown, path: string): string | undefined {
  let current: unknown = errors;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') return undefined;
  const message = (current as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

export interface FormProps<TValues extends FieldValues> {
  readonly form: UseFormReturn<TValues>;
  readonly onSubmit: (values: TValues) => void | Promise<void>;
  readonly children: ReactNode;
  readonly className?: string;
  /**
   * Announced above the fields when the submit itself failed — a 409, a network
   * error, a server rule the client cannot check. Separate from field errors
   * because it is not about any one field.
   */
  readonly submitError?: string;
}

/**
 * The `<form>` element plus the react-hook-form context, so every `FormField`
 * below it can find its own error without being handed it.
 *
 * `noValidate` on purpose. The browser's own validation bubbles are unstyled,
 * untranslatable and fire before the Zod resolver, so leaving them on means a
 * user sees an English "Please fill out this field" in a Bangla form and never
 * reaches the message the contract wrote.
 */
export function Form<TValues extends FieldValues>({
  form,
  onSubmit,
  children,
  className,
  submitError,
}: FormProps<TValues>) {
  return (
    <FormProvider {...form}>
      <form
        noValidate
        className={cn('space-y-4', className)}
        onSubmit={(event) => {
          void form.handleSubmit((values) => onSubmit(values))(event);
        }}
      >
        {submitError === undefined ? null : (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
          >
            {submitError}
          </p>
        )}
        {children}
      </form>
    </FormProvider>
  );
}
