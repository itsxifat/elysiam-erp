import { Sheet } from '@elysium/ui';

import { useT } from '../i18n/locale.js';
import { SidebarContent } from './sidebar.js';

/**
 * The sidebar as a drawer, on a phone (D-449). Its own chunk: most sessions are on a
 * desk, and the drawer's dialog is not worth the first paint there.
 */
export function MobileNav({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('nav.sidebar')}
      closeLabel={t('common.close')}
      side="left"
      size="sm"
      className="w-[min(18rem,calc(100vw-3rem))] [&>div:nth-child(2)]:px-0 [&>div:nth-child(2)]:py-0"
    >
      <SidebarContent mode="drawer" onNavigate={() => onOpenChange(false)} />
    </Sheet>
  );
}
