import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Where a connection's base URL may take the ERP (M47, D-830): its name is checked as text when
 * it is saved (`envoBaseUrl`: https, a named public host), and here the addresses that name
 * resolves to are checked before every request, as Envo checks its own webhooks' targets
 * (`resolvePublicUrl`). A name a supervisor typed that points at the server itself, its
 * neighbours on the brands server's network or the cloud's metadata address is refused, so the
 * API key is not sent there and the ERP is no way to probe its own network.
 *
 * Refused: loopback, unspecified, link-local (169.254/16, the metadata address, fe80::/10),
 * private (RFC 1918, fc00::/7), shared (100.64/10, CGNAT), benchmarking (198.18/15),
 * multicast and reserved, IPv4-mapped ones included. A private address the brand's own Envo
 * really is on (its DNS answered with the LAN address) is allowed by listing it in
 * `TELEPHONY_ENVO_PRIVATE_CIDRS`. A name that does not resolve is left to the request, which
 * reports it unreachable. The check runs before the request resolves the name again, so it does
 * not close DNS rebinding between the two; it closes every name that simply points inside.
 */

export interface Cidr {
  readonly base: number;
  readonly bits: number;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** `10.0.0.0/8` or `192.168.20.237` (a /32), IPv4 only; null when it is not one. */
export function parseCidr(value: string): Cidr | null {
  const [address = '', size] = value.trim().split('/', 2);
  const base = ipv4ToInt(address);
  if (base === null) return null;
  const bits = size === undefined ? 32 : Number(size);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { base, bits };
}

function inCidr(value: number, cidr: Cidr): boolean {
  if (cidr.bits === 0) return true;
  const size = 2 ** (32 - cidr.bits);
  return Math.floor(value / size) === Math.floor(cidr.base / size);
}

const REFUSED_V4: readonly (readonly [string, string])[] = [
  ['0.0.0.0/8', 'unspecified'],
  ['127.0.0.0/8', 'loopback'],
  ['10.0.0.0/8', 'private'],
  ['172.16.0.0/12', 'private'],
  ['192.168.0.0/16', 'private'],
  ['169.254.0.0/16', 'link-local'],
  ['100.64.0.0/10', 'shared'],
  ['198.18.0.0/15', 'benchmarking'],
  ['192.0.0.0/24', 'reserved'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
];
const REFUSED = REFUSED_V4.map(([cidr, why]) => ({ cidr: parseCidr(cidr)!, why }));

/** Why this address is no Envo's, or null. `allowed` are private ranges the brand listed. */
export function refusedEnvoAddress(address: string, allowed: readonly Cidr[] = []): string | null {
  const lower = address.toLowerCase();
  const mapped = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  if (isIP(mapped) === 4) {
    const value = ipv4ToInt(mapped);
    if (value === null) return 'unreadable';
    if (allowed.some((cidr) => inCidr(value, cidr))) return null;
    return REFUSED.find((entry) => inCidr(value, entry.cidr))?.why ?? null;
  }
  if (isIP(lower) === 6) {
    if (lower === '::' || lower === '::1') return lower === '::' ? 'unspecified' : 'loopback';
    if (/^fe[89ab]/.test(lower)) return 'link-local';
    if (/^f[cd]/.test(lower)) return 'private';
    if (lower.startsWith('ff')) return 'multicast';
    return null;
  }
  return 'unreadable';
}

/** The check the gateway runs before each request: why the host is refused, or null. */
export function envoHostCheck(
  allowed: readonly Cidr[],
): (hostname: string) => Promise<string | null> {
  return async (hostname) => {
    let addresses: readonly { readonly address: string }[];
    try {
      addresses = await lookup(hostname.replace(/^\[|\]$/g, ''), { all: true });
    } catch {
      return null;
    }
    for (const { address } of addresses) {
      const why = refusedEnvoAddress(address, allowed);
      if (why !== null) return why;
    }
    return null;
  };
}
