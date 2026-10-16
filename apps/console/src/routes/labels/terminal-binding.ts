import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { ApiError } from '../../api.js';

/**
 * "This computer is Packing 2" (M46, D-803): the binding a supervisor made on this browser, kept
 * in its local storage and confirmed with the server by a check-in every half minute. The token
 * goes with every piece of the terminal's work (`x-terminal-device`); the server, not this file,
 * decides whether it still counts and whether the person signed in may work there.
 */

export interface TerminalBinding {
  readonly token: string;
  readonly deviceId: string;
  readonly label: string;
  readonly terminalId: string;
  readonly terminalName: string;
  readonly kind: 'packing' | 'label';
}

const KEY = 'erp.terminal';
const listeners = new Set<() => void>();

function read(): TerminalBinding | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<TerminalBinding>;
    if (
      typeof value.token !== 'string' ||
      !value.token.startsWith('tdt_') ||
      typeof value.terminalId !== 'string' ||
      (value.kind !== 'packing' && value.kind !== 'label')
    ) {
      return null;
    }
    return {
      token: value.token,
      deviceId: String(value.deviceId ?? ''),
      label: String(value.label ?? ''),
      terminalId: value.terminalId,
      terminalName: String(value.terminalName ?? ''),
      kind: value.kind,
    };
  } catch {
    return null;
  }
}

let cached: TerminalBinding | null | undefined;

function snapshot(): TerminalBinding | null {
  cached ??= typeof window === 'undefined' ? null : read();
  return cached;
}

function notify(): void {
  cached = undefined;
  for (const listener of listeners) listener();
}

/** The token this browser sends, or null when it is not bound. */
export function terminalToken(): string | null {
  return snapshot()?.token ?? null;
}

export function saveBinding(binding: TerminalBinding): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(binding));
  } catch {
    // Storage refused (a private window): the binding lasts this page only.
  }
  cached = binding;
  for (const listener of listeners) listener();
}

export function clearBinding(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to remove.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) notify();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useTerminalBinding(): TerminalBinding | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * The check-in (D-803): every thirty seconds while Labels or Packaging is open. A binding the
 * server no longer knows (revoked, or its terminal switched off) is forgotten here.
 */
export function useTerminalCheckIn() {
  const binding = useTerminalBinding();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['terminals', 'check-in', binding?.token ?? 'none'],
    enabled: binding !== null,
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
    retry: false,
    queryFn: async () => {
      const { checkIn } = await import('./api.js');
      try {
        return await checkIn();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'TERMINAL_DEVICE_INVALID') {
          clearBinding();
          void queryClient.invalidateQueries({ queryKey: ['terminals'] });
        }
        throw error;
      }
    },
  });
  const forget = useCallback(() => clearBinding(), []);
  return { binding, checkIn: query.data, error: query.error, forget };
}
