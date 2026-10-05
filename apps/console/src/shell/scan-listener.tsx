import { createScanDetector, normaliseScannedCode } from '@elysium/domain/barcode';
import { Button } from '@elysium/ui';
import { useNavigate } from '@tanstack/react-router';
import { ScanLine } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from '../api.js';
import { useAbility } from '../auth/session.js';
import { useT } from '../i18n/locale.js';
import '../i18n/stock-tools.js';
import { currentScanHandler, isTypingTarget } from '../lib/scanner.js';
import { CameraScanButton } from '../routes/catalog/camera-scan.js';

/**
 * The scanner, anywhere in the console (M38a, D-605).
 *
 * Listens to every key press, before anything else does, and tells a barcode scanner from a
 * person typing (`createScanDetector`: eight or more characters, each within 35 ms of the
 * last, ended by Enter). Key presses inside a text box are left alone, so typing into a form
 * is never mistaken for a scan, unless the box opted in (`data-scan="accept"`).
 *
 * A scan goes to the stock screen that is listening (`useScanHandler`), or, with none,
 * opens the product at that variant. Enter's own action is cancelled, so a scan with focus
 * on a button does not also press it.
 *
 * Loaded as its own chunk once the shell has painted: it costs the first screen nothing.
 */
export function ScanListener() {
  const t = useT();
  const ability = useAbility();
  const navigate = useNavigate();
  const mayOpen = ability.can('read', 'Catalog');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const timer = useRef(0);

  const say = useCallback((text: string, error: boolean) => {
    window.clearTimeout(timer.current);
    setNotice({ text, error });
    timer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const open = useCallback(
    async (raw: string) => {
      const code = normaliseScannedCode(raw);
      if (code === '') return;
      const handler = currentScanHandler();
      if (handler !== undefined) {
        handler(code);
        return;
      }
      if (!mayOpen) {
        say(t('st.scan.cannotOpen'), true);
        return;
      }
      say(t('st.scan.opening'), false);
      try {
        const found = await api.get<{ product: { id: string }; sku: { id: string } }>(
          `/v1/catalog/lookup?code=${encodeURIComponent(code)}`,
        );
        setNotice(null);
        await navigate({
          to: '/catalog/$productId',
          params: { productId: found.product.id },
          search: { variant: found.sku.id },
        });
      } catch (error) {
        say(
          error instanceof ApiError && error.status === 404
            ? t('st.scan.notFound')
            : t('st.scan.failed'),
          true,
        );
      }
    },
    [mayOpen, navigate, say, t],
  );

  useEffect(() => {
    const detector = createScanDetector();
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
        detector.reset();
        return;
      }
      if (isTypingTarget(event.target)) {
        detector.reset();
        return;
      }
      const step = detector.push({ key: event.key, at: event.timeStamp });
      if (step.kind !== 'scan') return;
      event.preventDefault();
      event.stopPropagation();
      void open(step.code);
    }
    // Capture, so the scan is seen before a dialog's own key handling.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.clearTimeout(timer.current);
    };
  }, [open]);

  return (
    <>
      {mayOpen ? (
        // A phone has no scanner: its camera is one, from anywhere in the console.
        <div className="fixed right-4 bottom-4 z-40 md:hidden">
          <CameraScanButton size="icon-sm" onCode={(code) => void open(code)} />
        </div>
      ) : null}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex justify-center px-4 md:bottom-6"
      >
        {notice === null ? null : (
          <div
            data-testid="scan-notice"
            className={
              notice.error
                ? 'pointer-events-auto flex items-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm text-destructive shadow-md'
                : 'pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-md'
            }
          >
            <ScanLine aria-hidden="true" className="size-4" />
            {notice.text}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              onClick={() => setNotice(null)}
            >
              {t('st.close')}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
