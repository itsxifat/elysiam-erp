import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * The text input and its label, re-tuned to the tokens (§24, D-033).
 *
 * Two decisions worth stating, because both are the kind that a later edit
 * undoes without looking wrong:
 *
 * - **`border-input`, not `border-border`.** They are separate tokens for a
 *   reason: a field's edge has to read as an affordance against the same
 *   surface a hairline divider disappears into. Collapsing them is what makes a
 *   form look like a table.
 * - **`aria-invalid` drives the error styling, not a `error` boolean prop.**
 *   The attribute is what a screen reader acts on, so tying the colour to it
 *   means the visual and the announced states cannot disagree — which is the
 *   usual outcome when a component has both a red border prop and an ARIA prop
 *   and a caller sets one of them.
 *
 * `h-control` rather than a padding-derived height, so every control in a row —
 * input, select, button — lines up to the pixel.
 */
/**
 * `ComponentPropsWithRef`, so `ref` is part of the prop type.
 *
 * React 19 passes a function component's `ref` as an ordinary prop, and the form
 * fields need it: react-hook-form's `field.ref` is how a failed validation
 * focuses the first bad control. With `InputHTMLAttributes` the ref prop is a
 * type error, and the tempting fix — dropping it — silently removes focus
 * management from every form in the system.
 */
export type InputProps = ComponentPropsWithRef<'input'>;

export function Input({ className, ...rest }: InputProps) {
  return (
    <input
      className={cn(
        'h-control w-full rounded-md border border-input bg-background px-3 text-sm text-foreground',
        'placeholder:text-muted-foreground',
        'motion-safe:duration-fast motion-safe:transition-colors motion-safe:ease-out',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
        className,
      )}
      {...rest}
    />
  );
}

export interface LabelProps {
  readonly htmlFor?: string;
  readonly children: ReactNode;
  /** Renders the "required" marker *and* nothing else — see the note below. */
  readonly required?: boolean;
  readonly className?: string;
}

/**
 * A label bound to its control by id.
 *
 * Radix's `Label` rather than a bare `<label>` because it also fixes the
 * text-selection behaviour that makes a double-click on a label toggle the
 * control, which reads as a phantom click to anyone selecting a field name to
 * copy it.
 *
 * The required marker is an asterisk *plus* an accessible word. An asterisk
 * alone is a convention sighted users have learned and screen readers announce
 * as "star", so the real signal for assistive technology is `required` on the
 * input — which the field components set — and this is only its visual echo.
 */
export function Label({ htmlFor, children, required = false, className }: LabelProps) {
  return (
    <LabelPrimitive.Root
      {...(htmlFor === undefined ? {} : { htmlFor })}
      className={cn('text-sm font-medium text-foreground', className)}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-destructive" aria-hidden="true">
          *
        </span>
      ) : null}
    </LabelPrimitive.Root>
  );
}
