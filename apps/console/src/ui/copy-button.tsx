import { Button } from '@elysium/ui';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/**
 * Copy a text to the clipboard, with a tick for a moment after (M35b: a campaign link's
 * address, the marketplace's addresses, a scanner pairing code). Icon-only, so the caller
 * names it: `label` is what a screen reader announces.
 */
export function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}
