import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { Button } from './button.js';
import { cn } from '../lib/cn.js';

/**
 * The dialog, on Radix (§24, checks 6 and 7).
 *
 * Radix rather than a hand-rolled overlay for the three things that are easy to
 * write and almost impossible to write correctly: the focus trap, restoring
 * focus to the element that opened it, and the `aria-modal` wiring that stops a
 * screen reader wandering into the page behind. §24's accessibility floor names
 * "focus trapped and restored in dialogs" explicitly, and a hand-rolled version
 * is how you get a dialog that traps focus but drops it on the body when it
 * closes — after which the keyboard user is back at the top of the document with
 * no idea where they are.
 *
 * **The shadow lives only here.** §24: separation is a 1px hairline, and shadows
 * appear only on floating layers. `shadow-dialog` is a token, so the elevation
 * is one value for every dialog in the system rather than whatever each screen
 * felt like.
 *
 * The overlay is `bg-foreground/40` rather than a literal black: in dark mode a
 * black scrim over a near-black surface is invisible, so the dialog appears to
 * float over a live page the user can still click. Deriving it from the
 * foreground token means it inverts with the theme.
 */

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /** Announced with the title. Required, because a modal with no explanation of
   *  why it interrupted is the most common accessibility failure in an ERP. */
  readonly description?: string;
  readonly children?: ReactNode;
  /** The action row. Rendered right-aligned, primary last. */
  readonly footer?: ReactNode;
  /** The accessible name for the close button, from the caller's i18n. */
  readonly closeLabel: string;
  readonly className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel,
  className,
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={cn('fixed inset-0 z-50 bg-foreground/40')} />
        <DialogPrimitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
            // A long form on a short laptop screen scrolls inside the dialog rather
            // than running off both edges of a box that cannot scroll.
            'max-h-[calc(100dvh-2rem)] overflow-y-auto',
            'rounded-lg border border-border bg-card p-5 text-card-foreground shadow-dialog',
            'motion-safe:duration-base motion-safe:ease-out',
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <DialogPrimitive.Title className="text-base font-semibold tracking-tight">
                {title}
              </DialogPrimitive.Title>
              {description === undefined ? null : (
                <DialogPrimitive.Description className="text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label={closeLabel}>
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          {children === undefined ? null : <div className="mt-4">{children}</div>}
          {footer === undefined ? null : (
            <div className="mt-6 flex items-center justify-end gap-2">{footer}</div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  /** Extra context — the amount, the row, whatever the operator is deciding. */
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly closeLabel: string;
  /**
   * Destructive actions get the destructive variant. Not a colour prop: colour
   * means danger here, and a `tone="red"` is how a Save button ends up red.
   */
  readonly destructive?: boolean;
  /**
   * May be async. While it is in flight both buttons are disabled, because the
   * single most expensive bug in this class of dialog is a double-submitted
   * money movement — the operator clicks, nothing visibly happens, they click
   * again, and two journals post.
   */
  readonly onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  closeLabel,
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      // Cleared even on failure: the dialog stays open so the operator can read
      // the error and retry, and a permanently disabled Confirm button would
      // leave them with nothing to do but reload and lose their place.
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={busy ? () => undefined : onOpenChange}
      title={title}
      {...(description === undefined ? {} : { description })}
      closeLabel={closeLabel}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
