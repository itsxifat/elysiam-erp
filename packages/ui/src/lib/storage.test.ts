import { describe, expect, it } from 'vitest';

import { readStored, STORAGE_KEYS, writeStored, type KeyValueStore } from './storage.js';

/** A `Storage` over a Map, in insertion order like the browser's. */
function memory(initial: Record<string, string> = {}): KeyValueStore & { dump(): object } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    dump: () => Object.fromEntries(map),
  };
}

describe('readStored', () => {
  it('reads the neutral name', () => {
    expect(readStored(STORAGE_KEYS.theme, memory({ 'erp-theme': 'dark' }))).toBe('dark');
  });

  it('moves an older build’s value across once, and forgets the old name', () => {
    const store = memory({ 'acme-theme': 'dark', 'acme-locale': 'bn' });
    expect(readStored(STORAGE_KEYS.theme, store)).toBe('dark');
    expect(readStored(STORAGE_KEYS.consoleLocale, store)).toBe('bn');
    expect(store.dump()).toEqual({ 'erp-theme': 'dark', 'erp-locale': 'bn' });
  });

  it('keeps each app to its own slot when the three share an origin', () => {
    const store = memory({
      'acme-pos-locale': 'bn',
      'acme-portal-locale': 'en',
      'erp-pos-locale': 'bn',
    });
    // `acme-pos-locale` is not the console's locale, though it ends in `-locale`.
    expect(readStored(STORAGE_KEYS.consoleLocale, store)).toBeNull();
    expect(readStored(STORAGE_KEYS.portalLocale, store)).toBe('en');
    expect(readStored(STORAGE_KEYS.tillLocale, store)).toBe('bn');
  });

  it('answers null without storage', () => {
    expect(readStored(STORAGE_KEYS.theme, undefined)).toBeNull();
  });
});

describe('writeStored', () => {
  it('writes and clears the neutral name', () => {
    const store = memory();
    writeStored(STORAGE_KEYS.sidebar, '1', store);
    expect(store.dump()).toEqual({ 'erp-sidebar': '1' });
    writeStored(STORAGE_KEYS.sidebar, null, store);
    expect(store.dump()).toEqual({});
  });
});
