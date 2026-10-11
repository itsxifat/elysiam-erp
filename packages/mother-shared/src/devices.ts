/**
 * How a signed-in device is described on My account (M40, D-704): the browser and system
 * read from its user agent, and the address it signed in from, masked. Pure, so the server
 * describes and masks before anything leaves it, and the tests pin both.
 *
 * Deliberately small: the common browsers and systems an owner uses, by the tokens each
 * one puts in its user agent, checked in an order that tells them apart (Edge and Opera
 * also say "Chrome"; Chrome also says "Safari"). Anything else is "unknown", which the
 * console words in the reader's language.
 */

export interface DeviceDescription {
  readonly browser: string | null;
  readonly os: string | null;
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrome\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\bAndroid\b/, 'Android'],
  [/\biPhone\b|\biPod\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
  const text = (userAgent ?? '').slice(0, 512);
  const browser = BROWSERS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  return { browser, os };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The first half of an address: `103.129.*.*` for IPv4 (and IPv4 written as IPv6),
 * the first three groups for IPv6 (`2001:db8:85a3:*`). Enough to tell an office from a
 * phone network, not enough to find anyone. Anything unreadable shows nothing.
 */
export function maskAddress(address: string | null | undefined): string | null {
  if (address === null || address === undefined) return null;
  const trimmed = address.trim().replace(/^::ffff:/i, '');
  const v4 = IPV4.exec(trimmed);
  if (v4 !== null) {
    const parts = v4.slice(1, 5).map(Number);
    if (parts.some((part) => part > 255)) return null;
    return `${String(parts[0])}.${String(parts[1])}.*.*`;
  }
  if (/^[0-9a-f:]+$/i.test(trimmed) && trimmed.includes(':')) {
    const groups =
      trimmed
        .split('::')[0]
        ?.split(':')
        .filter((group) => group !== '') ?? [];
    const head = groups.slice(0, 3);
    if (head.length === 0) return null;
    return `${head.join(':').toLowerCase()}:*`;
  }
  return null;
}
