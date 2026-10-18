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
 * private (RFC 1918, fc00::/7, the old site-local fec0::/10), shared (100.64/10, CGNAT),
 * benchmarking (198.18/15), documentation (2001:db8::/32), discard (100::/64), multicast and
 * reserved, and an IPv6 address that carries an IPv4 one whose IPv4 is refused (IPv4-mapped
 * `::ffff:a.b.c.d`, IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), in
 * any spelling; local NAT64 (64:ff9b:1::/48) and Teredo (2001::/32) are refused outright. A
 * private address the brand's own Envo really is on (its DNS answered with the LAN address) is
 * allowed by listing it in `TELEPHONY_ENVO_PRIVATE_CIDRS`. A name that does not resolve is left
 * to the request, which reports it unreachable. The check runs before the request resolves the
 * name again, so it does not close DNS rebinding between the two; it closes every name that
 * simply points inside.
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

/**
 * An IPv6 address as its eight 16-bit groups, a dotted IPv4 tail and a zone id read too; null
 * when it is not one.
 */
function ipv6Groups(address: string): number[] | null {
  let text = (address.split('%')[0] ?? '').toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = ipv4ToInt(last);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 && halves[1] !== '' && halves[1] !== undefined ? halves[1].split(':') : [];
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const parts =
    halves.length === 2
      ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (parts.length !== 8 || !parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => parseInt(part, 16));
}

function refusedV4(value: number, allowed: readonly Cidr[]): string | null {
  if (allowed.some((cidr) => inCidr(value, cidr))) return null;
  return REFUSED.find((entry) => inCidr(value, entry.cidr))?.why ?? null;
}

/** Why this address is no Envo's, or null. `allowed` are private ranges the brand listed. */
export function refusedEnvoAddress(address: string, allowed: readonly Cidr[] = []): string | null {
  const lower = address.trim().toLowerCase();
  if (isIP(lower) === 4) {
    const value = ipv4ToInt(lower);
    return value === null ? 'unreadable' : refusedV4(value, allowed);
  }
  if (isIP(lower) !== 6) return 'unreadable';
  const g = ipv6Groups(lower);
  if (g === null) return 'unreadable';
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const v4 = (hi: number, lo: number) => hi * 65536 + lo;
  const zeros = (...groups: number[]) => groups.every((group) => group === 0);
  if (zeros(g0, g1, g2, g3, g4, g5, g6) && g7 === 0) return 'unspecified';
  if (zeros(g0, g1, g2, g3, g4, g5, g6) && g7 === 1) return 'loopback';
  // An IPv4 carried inside: mapped (::ffff:0:0/96), compatible (::/96), NAT64 (64:ff9b::/96).
  if (zeros(g0, g1, g2, g3, g4) && g5 === 0xffff) return refusedV4(v4(g6, g7), allowed);
  if (zeros(g0, g1, g2, g3, g4, g5)) return refusedV4(v4(g6, g7), allowed);
  if (g0 === 0x64 && g1 === 0xff9b) {
    return zeros(g2, g3, g4, g5) ? refusedV4(v4(g6, g7), allowed) : 'reserved';
  }
  // 6to4 (2002::/16) carries its IPv4 in the next two groups; Teredo's is obfuscated.
  if (g0 === 0x2002) return refusedV4(v4(g1, g2), allowed);
  if (g0 === 0x2001 && g1 === 0) return 'tunnel';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'documentation';
  if (g0 === 0x0100 && zeros(g1, g2, g3)) return 'discard';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local';
  if ((g0 & 0xffc0) === 0xfec0) return 'private';
  if ((g0 & 0xfe00) === 0xfc00) return 'private';
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  return null;
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
