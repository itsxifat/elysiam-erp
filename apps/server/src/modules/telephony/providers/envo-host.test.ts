import { describe, expect, it, vi } from 'vitest';

import { EnvoError, HttpEnvoGateway } from './envo-gateway.js';
import { envoHostCheck, parseCidr, refusedEnvoAddress, type Cidr } from './envo-host.js';

/**
 * Where a connection's base URL may take the API key (D-830, the recheck's security-5 and N5):
 * the addresses a name resolves to, checked before every request to Envo.
 */
describe('refusedEnvoAddress', () => {
  it('refuses the server itself, its neighbours and the metadata address', () => {
    const refused: readonly (readonly [string, string])[] = [
      ['127.0.0.1', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.254', 'private'],
      ['192.168.20.237', 'private'],
      ['169.254.169.254', 'link-local'],
      ['100.64.0.1', 'shared'],
      ['0.0.0.0', 'unspecified'],
      ['198.18.0.1', 'benchmarking'],
      ['224.0.0.1', 'multicast'],
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['0:0:0:0:0:0:0:1', 'loopback'],
      ['fe80::1', 'link-local'],
      ['febf::1', 'link-local'],
      ['fec0::1', 'private'],
      ['feff::1', 'private'],
      ['fd00::1', 'private'],
      ['fc00::1', 'private'],
      ['ff02::1', 'multicast'],
      ['2001:db8::1', 'documentation'],
      ['100::1', 'discard'],
      ['2001::1', 'tunnel'],
      ['64:ff9b:1::a9fe:a9fe', 'reserved'],
    ];
    for (const [address, why] of refused) expect(refusedEnvoAddress(address), address).toBe(why);
  });

  it('reads an IPv4 address carried inside an IPv6 one, however it is spelt', () => {
    const refused: readonly (readonly [string, string])[] = [
      ['::ffff:10.0.0.1', 'private'],
      ['::FFFF:127.0.0.1', 'loopback'],
      ['::ffff:a9fe:a9fe', 'link-local'],
      ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
      ['::10.0.0.1', 'private'],
      ['::a9fe:a9fe', 'link-local'],
      ['64:ff9b::a9fe:a9fe', 'link-local'],
      ['64:ff9b::192.168.1.1', 'private'],
      ['2002:a9fe:a9fe::1', 'link-local'],
      ['2002:7f00:1::', 'loopback'],
      ['fe80::1%eth0', 'link-local'],
    ];
    for (const [address, why] of refused) expect(refusedEnvoAddress(address), address).toBe(why);
    // A public IPv4 carried the same ways is a public address.
    expect(refusedEnvoAddress('::ffff:8.8.8.8')).toBeNull();
    expect(refusedEnvoAddress('64:ff9b::808:808')).toBeNull();
    expect(refusedEnvoAddress('2002:808:808::1')).toBeNull();
  });

  it('allows public addresses, and a private one the brand listed', () => {
    expect(refusedEnvoAddress('104.21.32.1')).toBeNull();
    expect(refusedEnvoAddress('8.8.8.8')).toBeNull();
    expect(refusedEnvoAddress('2606:4700::6810:84e5')).toBeNull();
    expect(refusedEnvoAddress('2001:4860:4860::8888')).toBeNull();
    const listed = [parseCidr('192.168.20.237/32')].filter((cidr): cidr is Cidr => cidr !== null);
    expect(refusedEnvoAddress('192.168.20.237', listed)).toBeNull();
    expect(refusedEnvoAddress('::ffff:192.168.20.237', listed)).toBeNull();
    expect(refusedEnvoAddress('192.168.20.238', listed)).toBe('private');
  });

  it('refuses what is no address', () => {
    expect(refusedEnvoAddress('envo.example')).toBe('unreadable');
    expect(refusedEnvoAddress('1.2.3')).toBe('unreadable');
  });
});

describe('parseCidr', () => {
  it('reads an IPv4 range or a single address, and nothing else', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ base: 0x0a000000, bits: 8 });
    expect(parseCidr('192.168.20.237')).toEqual({ base: 0xc0a814ed, bits: 32 });
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('fd00::/8')).toBeNull();
    expect(parseCidr('nonsense')).toBeNull();
  });
});

describe('envoHostCheck', () => {
  it('refuses a literal address inside the network without asking DNS', async () => {
    const check = envoHostCheck([]);
    expect(await check('127.0.0.1')).toBe('loopback');
    expect(await check('[::1]')).toBe('loopback');
    expect(await check('169.254.169.254')).toBe('link-local');
    expect(await check('8.8.8.8')).toBeNull();
  });

  it('lets a listed private address through', async () => {
    const listed = [parseCidr('10.20.0.0/16')].filter((cidr): cidr is Cidr => cidr !== null);
    expect(await envoHostCheck(listed)('10.20.1.5')).toBeNull();
  });
});

describe('the gateway with a host check', () => {
  it('refuses before anything is sent, so the API key never leaves', async () => {
    const fetch = vi.fn();
    const gateway = new HttpEnvoGateway({
      timeoutMs: 1_000,
      recordingTimeoutMs: 1_000,
      fetch,
      checkHost: () => Promise.resolve('private'),
    });
    const connection = { baseUrl: 'https://envo.example', apiKey: 'envo_live_never_sent' };
    const refused = await gateway.ping(connection).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(EnvoError);
    expect((refused as EnvoError).kind).toBe('refused');
    expect((refused as EnvoError).message).toContain('private');
    expect((refused as EnvoError).message).not.toContain('envo_live_never_sent');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks Envo when the host passes', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, sipServer: { id: 7, name: 'Brand' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const checkHost = vi.fn(() => Promise.resolve(null));
    const gateway = new HttpEnvoGateway({
      timeoutMs: 1_000,
      recordingTimeoutMs: 1_000,
      fetch,
      checkHost,
    });
    await gateway.ping({ baseUrl: 'https://envo.example', apiKey: 'k' });
    expect(checkHost).toHaveBeenCalledWith('envo.example');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
