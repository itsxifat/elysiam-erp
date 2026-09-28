import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useController, useFormContext, type FieldPath, type FieldValues } from 'react-hook-form';

import { FormField } from './form.js';
import { Input } from './input.js';
import { cn } from '../lib/cn.js';

/**
 * The five field types every module screen needs (M05 Build list).
 *
 * Each exists because the naive control is wrong in a specific, expensive way,
 * and those reasons are the whole content of this file:
 *
 * - **money** — `<input type="number">` parses into a JavaScript double. A taka
 *   amount at crore scale, in poisha, is above `Number.MAX_SAFE_INTEGER`, and
 *   `12345678901234567` silently becomes `12345678901234568`. Invariant 1 exists
 *   to stop exactly that, and a number input reintroduces it at every form in
 *   the system. So the control is `inputMode="decimal"` over a *string*, parsed
 *   to integer poisha by hand, and the form value is a decimal string.
 * - **phone** — a Bangladeshi mobile is eleven digits beginning `01`, and people
 *   type it with spaces, dashes, `+880` and `880`. Normalizing at the edge means
 *   the contract's regex sees one shape; not normalizing means a valid number is
 *   rejected because the user pasted it from a chat.
 * - **date** — a business date is an Asia/Dhaka calendar date (invariant 8),
 *   never an instant. `type="date"` yields `YYYY-MM-DD` with no zone, which is
 *   precisely right; what is wrong is turning it into a `Date` in the browser,
 *   which lands on the previous day for anyone east of Dhaka.
 * - **select** — Radix, for the keyboard and ARIA behaviour a styled `<div>` list
 *   never gets right.
 * - **async combobox** — the one control that talks to the server as you type,
 *   so it owns debouncing, the in-flight indicator and the "no matches" state.
 */

/** A field name on a form, with its values type carried through. */
type Name<TValues extends FieldValues> = FieldPath<TValues>;

interface BaseFieldProps<TValues extends FieldValues> {
  readonly name: Name<TValues>;
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

// --- text -------------------------------------------------------------------

export function TextField<TValues extends FieldValues>({
  name,
  label,
  hint,
  required,
  disabled,
  className,
  placeholder,
  autoComplete,
}: BaseFieldProps<TValues> & {
  readonly placeholder?: string;
  readonly autoComplete?: string;
}) {
  const form = useFormContext<TValues>();
  return (
    <FormField<TValues>
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      {(field) => (
        <Input
          {...field}
          {...form.register(name)}
          id={field.id}
          type="text"
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(autoComplete === undefined ? {} : { autoComplete })}
          {...(disabled === undefined ? {} : { disabled })}
          {...(required === true ? { required: true } : {})}
        />
      )}
    </FormField>
  );
}

// --- phone ------------------------------------------------------------------

/**
 * Reduce whatever was typed or pasted to the eleven-digit local form.
 *
 * `+880 1712-345678`, `880 1712 345678`, `01712-345678` and `1712345678` all
 * become `01712345678`. Exported because the same normalization has to happen
 * wherever a phone number is accepted — a POS lookup, an import, a search box —
 * and two spellings of "normalize a phone number" is how a customer ends up in
 * the database twice.
 */
export function normalizeBdPhone(input: string): string {
  const digits = input.replace(/\D+/g, '');
  const withoutCountry = digits.startsWith('880') ? digits.slice(3) : digits;
  // A bare `1XXXXXXXXX` is what you get from pasting an international form
  // without the country code; the leading zero is local notation, not data.
  return withoutCountry.startsWith('1') ? `0${withoutCountry}` : withoutCountry;
}

export function PhoneField<TValues extends FieldValues>({
  name,
  label,
  hint,
  required,
  disabled,
  className,
  placeholder,
}: BaseFieldProps<TValues> & { readonly placeholder?: string }) {
  const { field } = useController<TValues>({ name });

  return (
    <FormField<TValues>
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      {(rendered) => (
        <Input
          {...rendered}
          // `tel`, not `text`: it is what brings up a phone keypad on the mobile
          // devices half the order desk actually runs on.
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={18}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(disabled === undefined ? {} : { disabled })}
          value={typeof field.value === 'string' ? field.value : ''}
          onChange={(event) => field.onChange(normalizeBdPhone(event.target.value))}
          onBlur={field.onBlur}
          ref={field.ref}
        />
      )}
    </FormField>
  );
}

// --- money ------------------------------------------------------------------

/**
 * Taka typed by a human to integer poisha, or null when it is not a number yet.
 *
 * Returns a **string** of digits, not a bigint, because that is what crosses the
 * wire (§23: amounts are decimal strings, never JSON numbers) and because
 * converting to bigint here would mean converting back at submit time for no
 * gain. `null` for an unparseable value, so the caller can leave the field's
 * error to the Zod schema instead of inventing one.
 *
 * More than two decimal places is a rejection rather than a silent round.
 * Rounding here would be a money operation outside `packages/domain/src/money`,
 * which invariant 1 forbids for a reason: the user typed ৳10.005 and is entitled
 * to be told that is not an amount, not to discover later that the system chose
 * one of two neighbouring values on their behalf.
 */
export function takaToPoisha(input: string): string | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (trimmed === '') return null;
  const match = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (match === null) return null;

  const [, sign, whole = '', fraction] = match;
  if (whole === '' && (fraction === undefined || fraction === '')) return null;

  const paisa = (fraction ?? '').padEnd(2, '0');
  // String concatenation, never `Number(taka) * 100`. The multiplication is the
  // bug: 19.99 * 100 is 1998.9999999999998 in IEEE 754.
  const digits = `${whole === '' ? '0' : whole}${paisa}`.replace(/^0+(?=\d)/, '');
  return `${sign}${digits}`;
}

/** Integer poisha back to the taka string a human edits. */
export function poishaToTaka(poisha: string): string {
  const negative = poisha.startsWith('-');
  const digits = (negative ? poisha.slice(1) : poisha).padStart(3, '0');
  const whole = digits.slice(0, -2);
  const paisa = digits.slice(-2);
  return `${negative ? '-' : ''}${whole}.${paisa}`;
}

/**
 * A money field whose form value is integer poisha as a decimal string.
 *
 * The *display* value is taka, because nobody types poisha; the *stored* value is
 * poisha, because that is what the contract validates and the server stores. The
 * two are kept in separate state deliberately: deriving the display from the
 * stored value on every keystroke makes `10.` impossible to type — it parses to
 * `1000`, re-renders as `10.00`, and the caret jumps to the end.
 */
export function MoneyField<TValues extends FieldValues>({
  name,
  label,
  hint,
  required,
  disabled,
  className,
  currencySymbol = '৳',
}: BaseFieldProps<TValues> & { readonly currencySymbol?: string }) {
  const { field } = useController<TValues>({ name });
  const stored = typeof field.value === 'string' ? field.value : '';

  /*
   * The draft carries the poisha value it produced, and the display value is
   * *derived* rather than synchronized.
   *
   * The obvious implementation — an effect that calls `setText` whenever the form
   * value changes — is both a cascading render and wrong at the edges: it fires
   * once per keystroke to write back the value it just read. Pairing the draft with
   * its own parse instead makes the reconciliation a comparison during render. When
   * the form value changes from outside (a reset, a default loaded from the server,
   * a programmatic `setValue`) the pair no longer matches and the display falls back
   * to the stored value; while the user is typing it matches, so their in-progress
   * `10.` survives.
   */
  const [draft, setDraft] = useState<{ text: string; poisha: string }>(() => ({
    text: stored === '' ? '' : poishaToTaka(stored),
    poisha: stored,
  }));

  const text = draft.poisha === stored ? draft.text : stored === '' ? '' : poishaToTaka(stored);

  function type(next: string) {
    const parsed = takaToPoisha(next) ?? '';
    setDraft({ text: next, poisha: parsed });
    field.onChange(parsed);
  }

  return (
    <FormField<TValues>
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      {(rendered) => (
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
          >
            {currencySymbol}
          </span>
          <Input
            {...rendered}
            // `text` with `inputMode="decimal"`, never `type="number"`. A number
            // input hands us a double and also brings a spinner that increments
            // a money amount by 1 on a stray scroll wheel.
            type="text"
            inputMode="decimal"
            autoComplete="off"
            className="pr-3 pl-7 text-right tabular-nums"
            {...(disabled === undefined ? {} : { disabled })}
            value={text}
            onChange={(event) => type(event.target.value)}
            onBlur={() => {
              // Normalize on blur, not while typing: `10.` becomes `10.00` once
              // the user has left, which is the moment they stop caring where
              // the caret is.
              const parsed = takaToPoisha(text);
              if (parsed !== null) setDraft({ text: poishaToTaka(parsed), poisha: parsed });
              field.onBlur();
            }}
            ref={field.ref}
          />
        </div>
      )}
    </FormField>
  );
}

// --- date -------------------------------------------------------------------

/**
 * A business date: `YYYY-MM-DD`, Asia/Dhaka, never an instant (invariant 8).
 *
 * The native control, because it is keyboard-accessible, localized by the OS and
 * already emits exactly the string a business date is. A custom calendar popover
 * would be prettier and would be one more thing to get wrong about zones.
 */
export function DateField<TValues extends FieldValues>({
  name,
  label,
  hint,
  required,
  disabled,
  className,
  min,
  max,
}: BaseFieldProps<TValues> & { readonly min?: string; readonly max?: string }) {
  const form = useFormContext<TValues>();
  return (
    <FormField<TValues>
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      {(rendered) => (
        <Input
          {...rendered}
          {...form.register(name)}
          id={rendered.id}
          type="date"
          className="tabular-nums"
          {...(min === undefined ? {} : { min })}
          {...(max === undefined ? {} : { max })}
          {...(disabled === undefined ? {} : { disabled })}
        />
      )}
    </FormField>
  );
}

// --- select -----------------------------------------------------------------

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export function SelectField<TValues extends FieldValues>({
  name,
  label,
  hint,
  required,
  disabled,
  className,
  options,
  placeholder,
}: BaseFieldProps<TValues> & {
  readonly options: readonly SelectOption[];
  readonly placeholder: string;
}) {
  const { field } = useController<TValues>({ name });

  return (
    <FormField<TValues>
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      {(rendered) => (
        <SelectPrimitive.Root
          value={typeof field.value === 'string' ? field.value : ''}
          onValueChange={field.onChange}
          {...(disabled === true ? { disabled: true } : {})}
        >
          <SelectPrimitive.Trigger
            id={rendered.id}
            aria-describedby={rendered['aria-describedby']}
            aria-invalid={rendered['aria-invalid']}
            aria-errormessage={rendered['aria-errormessage']}
            className={cn(
              'flex h-control w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm',
              'motion-safe:duration-fast motion-safe:transition-colors motion-safe:ease-out',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
              'disabled:cursor-not-allowed disabled:opacity-60',
              'aria-invalid:border-destructive',
              'data-placeholder:text-muted-foreground',
            )}
          >
            <SelectPrimitive.Value placeholder={placeholder} />
            <SelectPrimitive.Icon>
              <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
            </SelectPrimitive.Icon>
          </SelectPrimitive.Trigger>

          <SelectPrimitive.Portal>
            <SelectPrimitive.Content
              position="popper"
              sideOffset={4}
              className="z-50 max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-popover"
            >
              <SelectPrimitive.Viewport className="p-1">
                {options.map((option) => (
                  <SelectPrimitive.Item
                    key={option.value}
                    value={option.value}
                    {...(option.disabled === true ? { disabled: true } : {})}
                    className={cn(
                      'flex h-control-sm cursor-pointer items-center justify-between gap-2 rounded-sm px-2 text-sm outline-none',
                      'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
                      'data-disabled:pointer-events-none data-disabled:opacity-50',
                    )}
                  >
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator>
                      <Check aria-hidden="true" className="size-4" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Viewport>
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
      )}
    </FormField>
  );
}

// --- async combobox ---------------------------------------------------------

export interface ComboboxFieldProps<TValues extends FieldValues> extends BaseFieldProps<TValues> {
  /**
   * Ask the server. Given an `AbortSignal`, because the interesting case is the
   * fourth keystroke landing while the second request is still open: without
   * cancellation the second response can arrive last and repaint the list with
   * results for a query the user has already moved past.
   */
  readonly search: (query: string, signal: AbortSignal) => Promise<readonly SelectOption[]>;
  /** The label for a value that is already set, so it reads as a name. */
  readonly initialLabel?: string;
  readonly placeholder: string;
  readonly loadingLabel: string;
  readonly noMatchesLabel: string;
  /** Milliseconds of quiet before asking. 250 is a typing pause, not a lag. */
  readonly debounceMs?: number;
}

export function ComboboxField<TValues extends FieldValues>({
  name,
  label,
  hint,
  required,
  disabled,
  className,
  search,
  initialLabel,
  placeholder,
  loadingLabel,
  noMatchesLabel,
  debounceMs = 250,
}: ComboboxFieldProps<TValues>) {
  const { field } = useController<TValues>({ name });
  const listId = useId();

  const [query, setQuery] = useState(initialLabel ?? '');
  const [options, setOptions] = useState<readonly SelectOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      search(query, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) setOptions(results);
        })
        .catch(() => {
          // A failed lookup is an empty list, not a crash: the operator can keep
          // typing, and a thrown promise here would take the whole form down.
          if (!controller.signal.aborted) setOptions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open, search, debounceMs]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const selected = useMemo(
    () => options.find((option) => option.value === field.value) ?? null,
    [options, field.value],
  );

  return (
    <FormField<TValues>
      name={name}
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(required === undefined ? {} : { required })}
      {...(className === undefined ? {} : { className })}
    >
      {(rendered) => (
        <div ref={containerRef} className="relative">
          <Input
            {...rendered}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            placeholder={placeholder}
            {...(disabled === undefined ? {} : { disabled })}
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              // Clear the bound value the moment the text stops describing it.
              // Leaving the old id in place is how a form submits the customer
              // the operator had selected before they retyped the name.
              if (selected !== null && event.target.value !== selected.label) field.onChange('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
            ref={field.ref}
          />

          {busy ? (
            <span
              role="status"
              aria-label={loadingLabel}
              className="absolute top-1/2 right-3 -translate-y-1/2"
            >
              <Loader2
                aria-hidden="true"
                className="size-4 text-muted-foreground motion-safe:animate-spin motion-reduce:animate-none"
              />
            </span>
          ) : null}

          {open ? (
            <ul
              id={listId}
              role="listbox"
              aria-label={label}
              className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-popover"
            >
              {options.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">
                  {busy ? loadingLabel : noMatchesLabel}
                </li>
              ) : (
                options.map((option) => (
                  <li key={option.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.value === field.value}
                      onClick={() => {
                        field.onChange(option.value);
                        setQuery(option.label);
                        setOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                    >
                      {option.label}
                      {option.value === field.value ? (
                        <Check aria-hidden="true" className="size-4 shrink-0" />
                      ) : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      )}
    </FormField>
  );
}
