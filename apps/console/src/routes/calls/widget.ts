/**
 * Envo's embedded phone (M47, D-843), as `web/embed/phone.ts` in Envo's own source defines it:
 * one script, `<base URL>/embed/phone.js`, that defines `window.Envo.phone(options)`. The console
 * loads it only for a person with an extension, only when their phone starts, and only from
 * their connection's base URL (the console's Content-Security-Policy names the hosts it may come
 * from, `VITE_CSP_TELEPHONY_ORIGINS`).
 *
 * The phone exchanges the ERP's short-lived token for the extension's SIP credentials at Envo
 * (`POST <base>/api/embed/session`, allowed only from the origins on Envo's API key) and
 * registers over the WebSocket that answer names, `wss://<Envo's SIP domain>/ws`: on the owner's
 * Envo that is `call.enfinito.cloud`, not the dashboard's host, so the console's policy lists the
 * phone's sockets on their own (`VITE_CSP_TELEPHONY_SOCKETS`, D-844). `headless` hides Envo's
 * floating button; Envo's panel still opens on a call unless the console closes it, which it
 * does, showing its own card instead.
 */

/** Why the phone's script did not load, for the console to say in its own words. */
export class EnvoLoadError extends Error {
  constructor(
    readonly reason: 'blocked' | 'missing',
    readonly host: string,
  ) {
    super(reason);
    this.name = 'EnvoLoadError';
  }
}

declare const __TELEPHONY_SOCKETS__: readonly string[] | undefined;

/**
 * The `wss:` origins this build's Content-Security-Policy lets the phone open (vite.config.ts
 * writes the same list into the policy and here), or null when the build named none (a test).
 */
export function allowedPhoneSockets(): readonly string[] | null {
  return typeof __TELEPHONY_SOCKETS__ === 'undefined' ? null : __TELEPHONY_SOCKETS__;
}

/** Whether the phone may open its SIP socket on Envo's SIP domain under this build's policy. */
export function phoneSocketAllowed(sipDomain: string | null): boolean {
  const allowed = allowedPhoneSockets();
  if (sipDomain === null || allowed === null) return true;
  const socket = `wss://${sipDomain.toLowerCase()}`;
  return allowed.some((source) => source.toLowerCase() === socket);
}

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
      if (loaded?.phone === undefined) {
        loading.delete(origin);
        reject(new EnvoLoadError('missing', new URL(origin).host));
      } else resolve(loaded);
    });
    script.addEventListener('error', () => {
      loading.delete(origin);
      reject(new EnvoLoadError('blocked', new URL(origin).host));
    });
    document.head.append(script);
  });
  loading.set(origin, promise);
  return promise;
}
