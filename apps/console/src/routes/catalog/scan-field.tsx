import { normaliseScannedCode } from '@elysium/domain/barcode';
import { cn, controlClassName } from '@elysium/ui';
import { ScanLine } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import { useScanHandler } from '../../lib/scanner.js';
import { CameraScanButton } from './camera-scan.js';

/**
 * The scan field on a stock screen (M38a, D-605): focused when the screen opens, so a
 * scanner's keystrokes land here; Enter (which every scanner sends) hands the code over and
 * clears the box for the next piece. Typing a code by hand works the same way. While the
 * field is on screen it also takes scans that arrive with focus elsewhere (`useScanHandler`),
 * so a piece is never lost to a misplaced cursor.
 *
 * `message` is the screen's answer to the last scan ("Added: Linen Panjabi, M"), read out by
 * screen readers.
 */
export function ScanField({
  onCode,
  message,
  tone = 'neutral',
  autoFocus = true,
  label,
  hint,
  className,
}: {
  readonly onCode: (code: string) => void;
  readonly message?: string | null;
  readonly tone?: 'neutral' | 'error';
  readonly autoFocus?: boolean;
  readonly label?: string;
  /** The line under the field; the stock screens' "each scan adds one piece" by default. */
  readonly hint?: string;
  readonly className?: string;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const submit = (raw: string) => {
    const code = normaliseScannedCode(raw);
    setValue('');
    if (code !== '') onCode(code);
    input.current?.focus();
  };

  useScanHandler(submit);

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label ?? t('st.scan.label')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <ScanLine
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            id={id}
            ref={input}
            value={value}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            data-testid="scan-field"
            aria-describedby={`${id}-hint ${id}-status`}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              submit(value);
            }}
            className={cn(controlClassName, 'w-full pl-8 font-mono tabular-nums')}
          />
        </div>
        <CameraScanButton onCode={submit} />
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint ?? t('st.scan.hint')}
      </p>
      {/* A live region without the status role: the dialog around the field has its own
          status line, and two in one dialog would make "the status" ambiguous. */}
      <p
        id={`${id}-status`}
        aria-live="polite"
        aria-atomic="true"
        className={cn('min-h-5 text-sm', tone === 'error' ? 'text-destructive' : 'text-foreground')}
      >
        {message ?? ''}
      </p>
    </div>
  );
}
