import { Dialog } from '@elysium/ui';
import type { ReactNode } from 'react';

import { usePosT } from '../i18n/locale.js';

/**
 * The kit's `Dialog` with the till's close label: focus trapped while open and
 * restored on close (§24), Escape closes, and the footer's primary action last.
 */
export function Modal({
  title,
  description,
  onClose,
  footer,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
}) {
  const t = usePosT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      {...(description === undefined ? {} : { description })}
      closeLabel={t('pos.action.close')}
      footer={footer}
    >
      {children}
    </Dialog>
  );
}
