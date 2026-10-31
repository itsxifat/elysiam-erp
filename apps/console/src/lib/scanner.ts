import { useEffect, useRef } from 'react';

/**
 * Who hears a barcode scan (M38a, D-605).
 *
 * A USB or Bluetooth scanner types the code and presses Enter. `ScanListener` in the shell
 * tells that from a person typing and hands the code here. A stock screen that wants scans
 * (receive, stock in hand, transfer, count, adjust) registers a handler while it is open, so a
 * scan adds a line there even when the scan field does not have focus; with no screen
 * listening, a scan opens the product it belongs to.
 *
 * The last screen to register wins, and unregistering restores the one before: a dialog
 * opened over the product page takes the scans while it is open and gives them back when it
 * closes.
 */

export type ScanHandler = (code: string) => void;

const handlers: { readonly id: number; readonly handle: ScanHandler }[] = [];
let nextId = 0;

/** The handler a scan goes to now, or undefined for "open the product". */
export function currentScanHandler(): ScanHandler | undefined {
  return handlers.at(-1)?.handle;
}

/** Take the scans while `enabled`; the latest `handler` is always the one called. */
export function useScanHandler(handler: ScanHandler, enabled = true): void {
  const latest = useRef(handler);
  // After each render, never during one: the registry calls whatever is newest.
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    nextId += 1;
    const id = nextId;
    handlers.push({ id, handle: (code) => latest.current(code) });
    return () => {
      const index = handlers.findIndex((entry) => entry.id === id);
      if (index >= 0) handlers.splice(index, 1);
    };
  }, [enabled]);
}

/**
 * Whether a key event happened where the person is typing: a text box, a text area, a
 * select or anything editable. The scanner listener leaves those alone, unless the field
 * opted in with `data-scan="accept"` (a search box where a scan should open the product).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-scan="accept"]') !== null) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
    type,
  );
}

/**
 * The search box a scan fills when no screen is listening (M50, D-925): the owner's words,
 * "if we scan any barcode with barcode scanner it must auto fill for product search, no need to
 * click the input field … do this trick for all other input fields for searching anything".
 * A search box opts in with `data-scan-search`; the last visible one in the page wins, which is
 * the one in an open dialog, because dialogs render at the end of the page.
 */
export function visibleScanSearch(): HTMLInputElement | null {
  const fields = [...document.querySelectorAll<HTMLInputElement>('input[data-scan-search]')].filter(
    (field) => !field.disabled && field.getClientRects().length > 0,
  );
  return fields.at(-1) ?? null;
}

/**
 * Put a value into an input the way typing would, so React's `onChange` hears it: through the
 * native setter (React tracks the value it last set) and a bubbling `input` event.
 */
export function fillInput(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  options: { readonly focus?: boolean } = {},
): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  if (options.focus !== false) {
    field.focus();
    if (field instanceof HTMLInputElement && field.type !== 'number') {
      field.setSelectionRange(value.length, value.length);
    }
  }
}

/**
 * A text field inside a screen that takes every scan (M50): `data-scan-capture` on the screen.
 * A scan typed into one of its quantity or charge boxes is taken back out of the box and goes
 * where scans go there; its search boxes (`data-scan-search`) keep what is typed into them.
 */
export function isCaptureTarget(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
  if (target.hasAttribute('data-scan-search')) return false;
  return target.closest('[data-scan-capture]') !== null && isTypingTarget(target);
}
