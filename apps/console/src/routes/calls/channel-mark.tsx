import type { MessageKey } from '@elysium/i18n';
import { cn } from '@elysium/ui';
import { MessagesSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { useLocale } from '../../i18n/locale.js';
// Before `inbox.channel.*` is read: the section that carries the channels' names.
import '../../i18n/inbox.js';

/**
 * A channel's mark (M47, D-861): small monochrome outlines of Messenger, Instagram and WhatsApp,
 * drawn in `currentColor` on lucide's 24-unit grid and stroke so they sit beside lucide's icons,
 * with the channel's name beside them (or as the accessible name when `labelHidden`). lucide
 * ships no brand marks, so these three are the one exception to the lucide-only rule; any other
 * channel gets lucide's `MessagesSquare`. The marks themselves are hidden from assistive tech.
 */
const MARKS: Readonly<Record<string, ReactNode>> = {
  messenger: (
    <>
      <path d="M12 2.5c-5.25 0-9.5 3.95-9.5 8.83 0 2.78 1.38 5.26 3.54 6.88V21.5l3.24-1.78c.86.24 1.77.36 2.72.36 5.25 0 9.5-3.95 9.5-8.75S17.25 2.5 12 2.5Z" />
      <path d="m7 13.5 3.5-3.75 2.25 2.25L17 9.5l-3.5 3.75-2.25-2.25Z" />
    </>
  ),
  instagram: (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
      <circle cx="12" cy="12" r="4.25" />
      <circle cx="17.5" cy="6.5" r="0.75" fill="currentColor" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M3.5 20.5 4.8 16.4A9 9 0 1 1 7.8 19.3Z" />
      <path d="M9 8.5c0 3.6 2.9 6.5 6.5 6.5l1-1.5-2-1-1 .9a4.6 4.6 0 0 1-2.4-2.4l.9-1-1-2Z" />
    </>
  ),
};

export function ChannelMark({
  channel,
  labelHidden = false,
  className,
}: {
  /** The inbox channel's kind: `messenger`, `instagram`, `whatsapp`, or another. */
  readonly channel: string;
  readonly labelHidden?: boolean;
  readonly className?: string;
}) {
  const { t } = useLocale();
  const key = `inbox.channel.${channel}` as MessageKey;
  const named = t(key);
  // A kind the inbox has no name for is shown as it came.
  const label = named === key ? channel : named;
  const mark = MARKS[channel];
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {mark === undefined ? (
        <MessagesSquare aria-hidden="true" className="size-4 shrink-0" />
      ) : (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4 shrink-0"
        >
          {mark}
        </svg>
      )}
      <span className={labelHidden ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}
