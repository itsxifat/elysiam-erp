import { Button } from '@elysium/ui';
import { cloneElement, useId, type ReactElement } from 'react';

import { ProductImage } from '../../ui/product-image.js';

/**
 * Small pieces the new-product form, the product page and the setup screen share
 * (plan `catalog-stock-ux`). Built only from the kit's Button and FileUpload and layout
 * utilities, so the redesign running in parallel restyles them with everything else.
 */

/** Toggle chips: one button per value, pressed when chosen. Keyboard-reachable. */
export function ChipGroup({
  legend,
  values,
  chosen,
  onToggle,
  disabled,
}: {
  readonly legend: string;
  readonly values: readonly { readonly id: string; readonly label: string }[];
  readonly chosen: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium text-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => {
          const on = chosen.includes(value.id);
          return (
            <Button
              key={value.id}
              type="button"
              size="sm"
              variant={on ? 'primary' : 'outline'}
              aria-pressed={on}
              disabled={disabled === true}
              onClick={() => onToggle(value.id)}
            >
              {value.label}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A product photo, and its large view on a click (D-929). */
export function Thumb({ fileId, alt }: { readonly fileId: string; readonly alt: string }) {
  return <ProductImage fileId={fileId} alt={alt} size="lg" className="rounded-lg" />;
}

/**
 * A label above its control, joined by id rather than by wrapping.
 *
 * Wrapping a select or a text box in its label makes the control's current value part
 * of its accessible name ("Category No category"), so a screen reader announces the
 * value twice and the name changes as the person types.
 */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly className?: string | undefined;
  /** One control; it is given the id the label points at. */
  readonly children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {cloneElement(children, { id })}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
