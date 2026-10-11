import type { InboxKey } from '@elysium/i18n';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the section that carries them (M42).
import '../../i18n/inbox.js';
import { fill } from './logic.js';

/**
 * The strings the inbox renders (M42). The values live in the `inbox` section of
 * `packages/i18n`; `{name}` placeholders are filled from `values`.
 */
export function useInboxT(): (key: InboxKey, values?: Readonly<Record<string, string>>) => string {
  const { t } = useLocale();
  return (key, values) => fill(t(key), values ?? {});
}

export type { InboxKey };
