import type { PeopleKey } from '@elysium/i18n';
import { useCallback } from 'react';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the section that carries them (M48).
import '../../i18n/people.js';

/**
 * The strings M48's screens render. The values live in the `people` section of `packages/i18n`;
 * `{name}` placeholders are filled from `values`. The same function from render to render.
 */
export type PeopleT = (
  key: PeopleKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

export function usePeopleT(): PeopleT {
  const { t } = useLocale();
  return useCallback<PeopleT>(
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

/** A key built from a server value (a kind, a relation), when the catalogue has it. */
export function peopleKey(prefix: string, value: string): PeopleKey | null {
  const key = `people.${prefix}.${value}`;
  return KNOWN.has(key) ? (key as PeopleKey) : null;
}

const KNOWN = new Set<string>([
  ...['mobile', 'whatsapp', 'home', 'office', 'shop', 'other'].map((v) => `people.kind.${v}`),
  ...['own', 'household', 'relative', 'work', 'someone_else', 'other'].map(
    (v) => `people.relation.${v}`,
  ),
  ...['staff', 'order', 'website', 'inbox', 'call', 'import'].map((v) => `people.source.${v}`),
  ...['changed_number', 'wrong_number', 'not_theirs', 'other'].map((v) => `people.retire.${v}`),
]);
