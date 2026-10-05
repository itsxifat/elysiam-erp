/**
 * Browser storage under neutral names (M31, D-472).
 *
 * Every brand runs its own copy of the apps, so the names they keep things under in a
 * browser say nothing about whose they are: `erp-theme`, `erp-locale`, and so on. An
 * older build kept the same values under a product-specific prefix; the first read under
 * the new name moves such a value across once, so nobody loses a theme or a language.
 *
 * The old names are matched by their shape (`<word>-theme`), never spelled out, so no
 * shipped file carries them. Storage is per origin: anything of that shape on our origin
 * is ours.
 */

/** Where the apps' preferences live; one place, so the three apps agree. */
export const STORAGE_KEYS = {
  theme: { key: 'erp-theme', legacy: /^[a-z]+-theme$/ },
  consoleLocale: { key: 'erp-locale', legacy: /^[a-z]+-locale$/ },
  tillLocale: { key: 'erp-pos-locale', legacy: /^[a-z]+-pos-locale$/ },
  portalLocale: { key: 'erp-portal-locale', legacy: /^[a-z]+-portal-locale$/ },
  sidebar: { key: 'erp-sidebar', legacy: /^[a-z]+-sidebar$/ },
  navGroups: { key: 'erp-nav-groups', legacy: /^[a-z]+-nav-groups$/ },
  paletteRecent: { key: 'erp-palette-recent', legacy: /^[a-z]+-palette-recent$/ },
} as const satisfies Readonly<Record<string, { key: string; legacy: RegExp }>>;

export type StorageSlot = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** The minimum of `Storage` this needs, so a test can hand it a map. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function defaultStore(): KeyValueStore | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Storage denied (private browsing, a sandboxed frame).
    return undefined;
  }
}

/**
 * The value under `slot.key`, moving an older build's value across first when the new
 * name has none. Null when nothing is stored or storage is denied.
 */
export function readStored(
  slot: StorageSlot,
  store: KeyValueStore | undefined = defaultStore(),
): string | null {
  if (store === undefined) return null;
  try {
    const value = store.getItem(slot.key);
    if (value !== null) return value;
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (name === null || name === slot.key || !slot.legacy.test(name)) continue;
      // Never another slot's own key: `erp-pos-locale` is a till's, not the console's.
      if (Object.values(STORAGE_KEYS).some((other) => other.key === name)) continue;
      const old = store.getItem(name);
      if (old === null) continue;
      store.setItem(slot.key, old);
      store.removeItem(name);
      return old;
    }
  } catch {
    // Storage denied part-way: what was read stands.
  }
  return null;
}

export function writeStored(
  slot: StorageSlot,
  value: string | null,
  store: KeyValueStore | undefined = defaultStore(),
): void {
  if (store === undefined) return;
  try {
    if (value === null) store.removeItem(slot.key);
    else store.setItem(slot.key, value);
  } catch {
    // Storage denied: the value applies for this page only.
  }
}
