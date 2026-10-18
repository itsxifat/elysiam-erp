/**
 * Envo's embedded phone (M47, D-843), as `web/embed/phone.ts` in Envo's own source defines it:
 * one script, `<base URL>/embed/phone.js`, that defines `window.Envo.phone(options)`. The console
 * loads it only for a person with an extension, only when their phone starts, and only from
 * their connection's base URL (the console's Content-Security-Policy names the hosts it may come
 * from, `VITE_CSP_TELEPHONY_ORIGINS`).
 *
 * The phone exchanges the ERP's short-lived token for the extension's SIP credentials at Envo
 * (`POST <base>/api/embed/session`, allowed only from the origins on Envo's API key) and
 * registers over Envo's WebSocket. `headless` hides Envo's floating button; Envo's panel still
 * opens on a call unless the console closes it, which it does, showing its own card instead.
 */

export interface EnvoPhoneEvent {
  readonly type:
    'ready' | 'registered' | 'offline' | 'incoming' | 'accepted' | 'ended' | 'failed' | 'error';
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface EnvoPhone {
  call(target: string): void;
  answer(): void;
  hangup(): void;
  open(): void;
  close(): void;
  destroy(): void;
  readonly status: {
    readonly registration: string;
    readonly call: string;
    readonly extension: string | null;
  };
}

interface EnvoGlobal {
  readonly phone: (options: {
    readonly token: string;
    readonly baseUrl: string;
    readonly headless: boolean;
    readonly position: 'bottom-right' | 'bottom-left';
    readonly onEvent: (event: EnvoPhoneEvent) => void;
  }) => EnvoPhone;
}

const loading = new Map<string, Promise<EnvoGlobal>>();

/** The script from this origin, once per page. Rejects when it cannot be loaded (or the CSP refuses it). */
export function loadEnvo(baseUrl: string): Promise<EnvoGlobal> {
  const origin = new URL(baseUrl).origin;
  const existing = loading.get(origin);
  if (existing !== undefined) return existing;
  const promise = new Promise<EnvoGlobal>((resolve, reject) => {
    const present = (window as unknown as { Envo?: EnvoGlobal }).Envo;
    if (present?.phone !== undefined) {
      resolve(present);
      return;
    }
    const script = document.createElement('script');
    script.src = `${origin}/embed/phone.js`;
    script.async = true;
    script.addEventListener('load', () => {
      const loaded = (window as unknown as { Envo?: EnvoGlobal }).Envo;
      if (loaded?.phone === undefined) reject(new Error('Envo’s phone did not load.'));
      else resolve(loaded);
    });
    script.addEventListener('error', () => {
      loading.delete(origin);
      reject(new Error(`The phone could not be loaded from ${new URL(origin).host}.`));
    });
    document.head.append(script);
  });
  loading.set(origin, promise);
  return promise;
}
