import type { TelephonyKey, WorkflowKey } from '@elysium/i18n';
import { useCallback } from 'react';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the sections that carry them (M47, and M41's outcomes).
import '../../i18n/telephony.js';
import '../../i18n/workflow.js';

/**
 * The strings the phone's screens render (M47). The values live in the `telephony` section of
 * `packages/i18n` (and M41's call outcomes in `workflow`); `{name}` placeholders are filled from
 * `values`. The function is the same one from render to render (it changes only with the
 * locale's own `t`), so a hook or effect that depends on it does not run again each render: the
 * web phone's start effect once did, and tore the phone down on every render.
 */
export type TelT = (
  key: TelephonyKey | WorkflowKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

export function useTelT(): TelT {
  const { t } = useLocale();
  return useCallback<TelT>(
    (key, values) => {
      let text = t(key);
      for (const [name, value] of Object.entries(values ?? {})) {
        text = text.split(`{${name}}`).join(String(value));
      }
      return text;
    },
    [t],
  );
}

export type { TelephonyKey };
