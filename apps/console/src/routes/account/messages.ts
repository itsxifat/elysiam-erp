import type { AccountKey, MessageKey } from '@elysium/i18n';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the section that carries them (M40).
import '../../i18n/account.js';

/**
 * The strings My account renders (M40). The values live in the `account` section of
 * `packages/i18n`, where bn and en parity is a type error; the role names are the Staff
 * screen's, shared rather than spelled twice.
 */
/** The section's lookup: `t(key)`, with `{name}` placeholders filled from `values`. */
export function useAccountT(): (
  key: AccountKey | Extract<MessageKey, `users.role.${string}`>,
  values?: Readonly<Record<string, string>>,
) => string {
  const { t } = useLocale();
  return (key, values) => fill(t(key), values ?? {});
}

/** Replace each `{name}` in a message with its value; an unknown name is left as it is. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
