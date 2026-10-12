import type { AliveKey, InboxKey } from '@elysium/i18n';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the sections that carry them (M42, M44a).
import '../../i18n/alive.js';
import '../../i18n/inbox.js';
import { fill } from './logic.js';

/**
 * The strings the inbox renders (M42), and the live layer's it shares (M44a: relative times,
 * days, alerts). The values live in the `inbox` and `alive` sections of `packages/i18n`;
 * `{name}` placeholders are filled from `values`.
 */
export function useInboxT(): InboxT {
  const { t } = useLocale();
  return (key, values) => fill(t(key), values ?? {});
}

export type InboxT = (
  key: InboxKey | AliveKey,
  values?: Readonly<Record<string, string>>,
) => string;

export type { InboxKey };
