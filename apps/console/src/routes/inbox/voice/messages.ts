import type { VoiceKey } from '@elysium/i18n';

import { useLocale } from '../../../i18n/locale.js';
// Before any of the keys below is read: the section that carries them (M45).
import '../../../i18n/voice.js';
import { fill } from '../logic.js';

/**
 * The strings voice messages and calls render (M45). The values live in the `voice` section of
 * `packages/i18n`; `{name}` placeholders are filled from `values`.
 */
export function useVoiceT(): (key: VoiceKey, values?: Readonly<Record<string, string>>) => string {
  const { t } = useLocale();
  return (key, values) => fill(t(key), values ?? {});
}

export type { VoiceKey };
