import { useSyncExternalStore } from 'react';

/**
 * Each person's sound settings (M44a, D-766): on or off, and how loud. Kept in this browser's
 * storage under a neutral name (D-472), read and written behind try/catch: storage denied (a
 * private window, a locked-down profile) means the choice lasts for this visit only. Another
 * tab of the console that changes it is heard through the `storage` event.
 */

export type SoundVolume = 'low' | 'medium' | 'high';

export interface SoundPrefs {
  readonly muted: boolean;
  readonly volume: SoundVolume;
}

const KEY = 'erp-sound';
const DEFAULTS: SoundPrefs = { muted: false, volume: 'medium' };
const VOLUMES: readonly SoundVolume[] = ['low', 'medium', 'high'];

/** What a stored value says, or the defaults for anything else. Pure, for the test. */
export function parseSoundPrefs(raw: string | null): SoundPrefs {
  if (raw === null) return DEFAULTS;
  try {
    const value = JSON.parse(raw) as { muted?: unknown; volume?: unknown } | null;
    return {
      muted: value?.muted === true,
      volume: VOLUMES.includes(value?.volume as SoundVolume)
        ? (value?.volume as SoundVolume)
        : DEFAULTS.volume,
    };
  } catch {
    return DEFAULTS;
  }
}

function read(): SoundPrefs {
  try {
    return parseSoundPrefs(localStorage.getItem(KEY));
  } catch {
    return current ?? DEFAULTS;
  }
}

let current: SoundPrefs | null = null;
const listeners = new Set<() => void>();

export function soundPrefs(): SoundPrefs {
  current ??= read();
  return current;
}

export function setSoundPrefs(next: Partial<SoundPrefs>): void {
  current = { ...soundPrefs(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage denied: the choice holds for this visit.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    current = parseSoundPrefs(event.newValue);
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The settings, re-rendering when they change here or in another tab. */
export function useSoundPrefs(): SoundPrefs {
  return useSyncExternalStore(subscribe, soundPrefs, () => DEFAULTS);
}
