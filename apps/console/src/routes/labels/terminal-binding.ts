import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

import { ApiError } from '../../api.js';
import { useSession } from '../../auth/session.js';

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

/** The brand a binding's token names (`tdt_<org id, 32 hex>_…`, D-803), as those 32 hex. */
export function tokenBrand(token: string): string | null {
  return /^tdt_([0-9a-f]{32})_/.exec(token)?.[1] ?? null;
}

/**
 * This browser's binding, when its terminal is the brand the person works in now (D-900). A
 * computer bound to brand A stays bound while its person works in brand B: nothing of B's is
 * printed or checked in there, and the binding is not forgotten for it, as it was when B's
 * check-in was refused.
 */
export function useBrandBinding(): TerminalBinding | null {
  const binding = useTerminalBinding();
  const orgId = useSession().context?.orgId;
  if (binding === null || orgId == null) return null;
  return tokenBrand(binding.token) === orgId.replace(/-/g, '').toLowerCase() ? binding : null;
}

/**
 * When the server last refused this browser's binding (D-900). A binding is forgotten on a second
 * refusal at least `FORGET_AFTER_MS` after the first: a brand switch caught between its two
 * requests (the check-in going out after the server's brand changed and before the console's)
 * is refused once, and by the next check-in the binding is another brand's and not checked in.
 */
let refusedAt: number | null = null;
const FORGET_AFTER_MS = 25_000;

/**
 * The check-in (D-803): every thirty seconds while Labels or Packaging is open, and on every page
 * of a label computer (D-900). A binding the server no longer knows (revoked, or its terminal
 * switched off) is forgotten here, on its second refusal; one to another brand is left alone
 * (`useBrandBinding`).
 */
export function useTerminalCheckIn() {
  const binding = useBrandBinding();
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
        const answer = await checkIn();
        refusedAt = null;
        return answer;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'TERMINAL_DEVICE_INVALID') {
          const now = Date.now();
          if (refusedAt !== null && now - refusedAt >= FORGET_AFTER_MS) {
            refusedAt = null;
            clearBinding();
            void queryClient.invalidateQueries({ queryKey: ['terminals'] });
          } else {
            refusedAt ??= now;
          }
        }
        throw error;
      }
    },
  });
  const forget = useCallback(() => clearBinding(), []);
  return { binding, checkIn: query.data, error: query.error, forget };
}
