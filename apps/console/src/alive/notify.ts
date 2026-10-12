/**
 * Desktop alerts (M44a, D-766): the browser's Notification API, used only while the console's
 * tab is hidden, so a person on another tab or window hears about a customer's message or an
 * offer. Permission is asked for once, politely: from a button the person presses, never on
 * load; "Not now" or any answer is remembered and the question is not put again.
 */

const ASKED_KEY = 'erp-notify-asked';

export type AlertPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function alertPermission(): AlertPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/** Whether to offer the "Turn on alerts" prompt: never asked, and the browser can. */
export function shouldOfferAlerts(): boolean {
  if (alertPermission() !== 'default') return false;
  try {
    return localStorage.getItem(ASKED_KEY) === null;
  } catch {
    return false;
  }
}

/** Remember that the question was put (answered or put off), so it is not put again. */
export function rememberAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, new Date().toISOString());
  } catch {
    // Storage denied: the prompt may show again next visit, which is harmless.
  }
}

/** Ask the browser, from a click. */
export async function askForAlerts(): Promise<AlertPermission> {
  rememberAsked();
  if (alertPermission() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return alertPermission();
  }
}

export interface DesktopAlert {
  readonly title: string;
  readonly body?: string;
  /** One alert per thing: a second with the same tag replaces the first. */
  readonly tag: string;
  readonly onClick?: () => void;
}

/** Show an alert if the tab is hidden and the person allowed them. */
export function alertIfHidden(alert: DesktopAlert): void {
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
  if (alertPermission() !== 'granted') return;
  try {
    const notification = new Notification(alert.title, {
      ...(alert.body === undefined ? {} : { body: alert.body.slice(0, 160) }),
      tag: alert.tag,
      // The console plays its own tone; the system's would be a second one.
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      alert.onClick?.();
    };
  } catch {
    // Some browsers allow alerts only from a service worker; the tone and the title still say it.
  }
}
