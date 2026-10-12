import type { InboxSellKey } from '@elysium/i18n';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the section that carries them (M44b).
import '../../i18n/inbox-sell.js';
import { fill } from './logic.js';

/**
 * The strings the panel's selling area renders (M44b). The values live in the `inbox-sell`
 * section of `packages/i18n`; `{name}` placeholders are filled from `values`.
 */
export function useSellT(): (
  key: InboxSellKey,
  values?: Readonly<Record<string, string>>,
) => string {
  const { t } = useLocale();
  return (key, values) => fill(t(key), values ?? {});
}

export type { InboxSellKey };
