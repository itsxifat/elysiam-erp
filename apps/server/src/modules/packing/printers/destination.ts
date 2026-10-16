import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

import { ipv4ToNumber, printerHostRefusal } from '@elysium/contracts';

/**
 * Where the worker may send a print (M46, D-812): an IPv4 address on the shop's LAN, as the form
 * already insisted (`printerHostRefusal`), and, checked again here at the moment of sending,
 * never one of the server's own networks:
 *
 * - inside a container (the brand server's worker), every network the container is attached
 *   to: its Docker networks, where Postgres, Valkey and Gotenberg answer;
 * - on a host (a developer's machine), the networks of its Docker and virtual-machine bridges
 *   (`docker0`, `br-…`, `veth…`, `virbr…`, `cni…`, `vEthernet (WSL)`), but not its own LAN card,
 *   which is where the printers are;
 * - and whatever `PRINTER_REFUSED_CIDRS` adds (comma-separated; default Docker's default bridge,
 *   `172.17.0.0/16`).
 *
 * A name is never resolved: the address is the address, so nothing can be pointed elsewhere
 * after the check.
 */

interface Network {
  readonly first: number;
  readonly last: number;
  readonly label: string;
}

/** A CIDR as its first and last address, or null when it is not one. */
export function parseCidr(cidr: string): Network | null {
  const [ip, bits] = cidr.trim().split('/');
  const start = ip === undefined ? null : ipv4ToNumber(ip);
  const prefix = Number(bits);
  if (start === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const first = Math.floor(start / size) * size;
  return { first, last: first + size - 1, label: cidr.trim() };
}

function netmaskBits(netmask: string): number {
  const value = ipv4ToNumber(netmask) ?? 0;
  let bits = 0;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if (Math.floor(value / 2 ** bit) % 2 === 1) bits += 1;
    else break;
  }
  return bits;
}

const BRIDGE = /^(docker\d*|br-|veth|virbr|cni|flannel|vEthernet \(WSL)/i;

/** The server's own networks a print must never go to. */
export function ownNetworks(
  options: {
    readonly interfaces?: ReturnType<typeof networkInterfaces>;
    readonly inContainer?: boolean;
    readonly refused?: string;
  } = {},
): Network[] {
  const inContainer = options.inContainer ?? existsSync('/.dockerenv');
  const networks: Network[] = [];
  for (const [name, addresses] of Object.entries(options.interfaces ?? networkInterfaces())) {
    if (!inContainer && !BRIDGE.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4') continue;
      const network = parseCidr(`${address.address}/${String(netmaskBits(address.netmask))}`);
      if (network !== null) networks.push({ ...network, label: `${name} ${network.label}` });
    }
  }
  const refused = options.refused ?? process.env.PRINTER_REFUSED_CIDRS ?? '172.17.0.0/16';
  for (const cidr of refused.split(',')) {
    if (cidr.trim() === '') continue;
    const network = parseCidr(cidr);
    if (network !== null) networks.push(network);
  }
  return networks;
}

/** Why the worker will not send to this address now, or null. */
export function destinationRefusal(
  host: string,
  networks: readonly Network[] = ownNetworks(),
): string | null {
  const refusal = printerHostRefusal(host);
  if (refusal !== null) return refusal;
  const number = ipv4ToNumber(host) ?? -1;
  if (networks.some((network) => number >= network.first && number <= network.last)) {
    return 'That address is on the server’s own network, not the shop’s. Use the printer’s address on the shop’s LAN.';
  }
  return null;
}
