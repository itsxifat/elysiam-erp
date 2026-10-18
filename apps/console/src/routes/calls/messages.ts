import type { TelephonyKey, WorkflowKey } from '@elysium/i18n';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the sections that carry them (M47, and M41's outcomes).
import '../../i18n/telephony.js';
import '../../i18n/workflow.js';

/**
 * The strings the phone's screens render (M47). The values live in the `telephony` section of
 * `packages/i18n` (and M41's call outcomes in `workflow`); `{name}` placeholders are filled from
 * `values`.
 */
export type TelT = (
  key: TelephonyKey | WorkflowKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

export function useTelT(): TelT {
  const { t } = useLocale();
  return (key, values) => {
    let text = t(key);
    for (const [name, value] of Object.entries(values ?? {})) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  };
}

export type { TelephonyKey };
