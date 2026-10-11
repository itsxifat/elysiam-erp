import { Button } from '@elysium/ui';
import { Check, Copy, Download, Printer } from 'lucide-react';
import { useState } from 'react';

import { codesFile, codesFileName } from './logic.js';
import { useAccountT } from './messages.js';

/**
 * Recovery codes, shown once (M40): the list, and three ways to keep it — copy, download, print.
 * Printing opens a plain page with the codes alone, so nothing else on the screen goes to paper.
 */
export function RecoveryCodes({
  codes,
  brandSlug,
}: {
  readonly codes: readonly string[];
  readonly brandSlug: string | null;
}) {
  const t = useAccountT();
  const [copied, setCopied] = useState(false);

  const download = () => {
    const blob = new Blob([codesFile(codes)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = codesFileName(brandSlug);
    link.click();
    URL.revokeObjectURL(url);
  };

  const print = () => {
    const page = window.open('', '_blank', 'width=480,height=640');
    if (page === null) return;
    const doc = page.document;
    doc.title = t('account.codes.printTitle');
    const heading = doc.createElement('h1');
    heading.textContent = t('account.codes.printTitle');
    const list = doc.createElement('ol');
    for (const code of codes) {
      const item = doc.createElement('li');
      item.textContent = code;
      list.append(item);
    }
    doc.body.append(heading, list);
    page.focus();
    page.print();
    page.close();
  };

  return (
    <div className="space-y-3">
      <ul
        aria-label={t('account.setup.codesTitle')}
        className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-muted p-3 font-mono text-sm text-foreground"
      >
        {codes.map((code) => (
          <li key={code} className="tabular-nums">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(codesFile(codes)).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t('account.codes.copied') : t('account.codes.copy')}
        </Button>
        <Button size="sm" variant="outline" onClick={download}>
          <Download aria-hidden="true" />
          {t('account.codes.download')}
        </Button>
        <Button size="sm" variant="outline" onClick={print}>
          <Printer aria-hidden="true" />
          {t('account.codes.print')}
        </Button>
      </div>
    </div>
  );
}
