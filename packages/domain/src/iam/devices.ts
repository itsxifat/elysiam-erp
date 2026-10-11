/**
 * A signed-in device as its owner sees it on My account → Devices (M40, D-695).
 *
 * The raw user agent and address never leave the server: the list shows a browser, a system,
 * a kind of device and the address with its last part hidden, which is enough for a person to
 * recognise their own phone and to notice one that is not theirs.
 */

export type DeviceKind = 'desktop' | 'phone' | 'tablet' | 'unknown';

export interface DeviceDescription {
  /** "Chrome", "Firefox", "Safari", "Edge", "Opera", "Samsung Internet", or null. */
  readonly browser: string | null;
  /** "Windows", "macOS", "Android", "iOS", "iPadOS", "Linux", "ChromeOS", or null. */
  readonly system: string | null;
  readonly kind: DeviceKind;
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  // Order matters: Edge, Opera and Samsung Internet all say "Chrome" too, and Chrome says
  // "Safari".
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPad\b/, 'iPadOS'],
  [/\biPhone\b|\biPod\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

function firstMatch(value: string, table: readonly (readonly [RegExp, string])[]): string | null {
  for (const [pattern, name] of table) if (pattern.test(value)) return name;
  return null;
}

/** A browser, a system and a kind of device from a user agent string, or nulls when unknown. */
export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
  const value = (userAgent ?? '').slice(0, 512);
  if (value.trim() === '') return { browser: null, system: null, kind: 'unknown' };

  const browser = firstMatch(value, BROWSERS);
  const system = firstMatch(value, SYSTEMS);
  // An Android phone says "Mobile"; an Android tablet does not.
  const mobile = /\bMobile\b|\biPhone\b|\biPod\b/.test(value);
  const kind: DeviceKind =
    system === 'iPadOS' || /\bTablet\b/.test(value) || (system === 'Android' && !mobile)
      ? 'tablet'
      : mobile
        ? 'phone'
        : system === null && browser === null
          ? 'unknown'
          : 'desktop';
  return { browser, system, kind };
}

/**
 * An address with its last part hidden: an IPv4 address to its /24 (`103.12.45.x`), an IPv6
 * one to its /48 (`2001:db8:12::/48`). Null for nothing usable. An IPv4-mapped IPv6 address
 * (`::ffff:1.2.3.4`) is treated as the IPv4 one.
 */
export function maskAddress(address: string | null | undefined): string | null {
  const value = (address ?? '').trim();
  if (value === '') return null;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  const v4 = mapped?.[1] ?? value;
  const parts = v4.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return `${parts[0] ?? ''}.${parts[1] ?? ''}.${parts[2] ?? ''}.x`;
  }

  if (/^[0-9a-f:]+$/i.test(value) && value.includes(':')) {
    const groups = expandIpv6(value);
    if (groups === null) return null;
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

/** The eight groups of an IPv6 address, without leading zeros, or null when it is not one. */
function expandIpv6(value: string): string[] | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':');
  const tail = halves.length === 2 && (halves[1] ?? '') !== '' ? (halves[1] ?? '').split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => group.replace(/^0+(?=.)/, '').toLowerCase());
}
