import { Button } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { cloneElement, useId, type ReactElement } from 'react';

import { imageUrl } from './api.js';

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

/** A product photo, through a short-lived signed address. */
export function Thumb({ fileId, alt }: { readonly fileId: string; readonly alt: string }) {
  const url = useQuery({
    queryKey: ['files', 'url', fileId],
    queryFn: () => imageUrl(fileId),
    // The address expires; re-ask well before it does.
    staleTime: 4 * 60_000,
  });
  return (
    <div className="flex size-24 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
      {url.data === undefined ? (
        <ImageOff aria-hidden className="size-5 text-muted-foreground" />
      ) : (
        <img src={url.data.url} alt={alt} className="size-full object-cover" />
      )}
    </div>
  );
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
