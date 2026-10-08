import { describe, expect, it } from 'vitest';

import {
  PACKING_CAMERAS_MAX_ENABLED,
  cameraHostRefusal,
  packingCameraCreateSchema,
  packingCameraUpdateSchema,
  packingOpenSchema,
  refusedCameraIp,
  rtspUrlSchema,
} from './packing.js';

/** The packing table's IP cameras at the edge (M38c, D-668, D-669). */

function refusal(value: unknown): string | null {
  const parsed = rtspUrlSchema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'refused');
}

describe('an IP camera’s RTSP address', () => {
  it('takes rtsp:// addresses with a host, a port and a path', () => {
    expect(refusal('rtsp://192.168.20.111:554/stream1')).toBeNull();
    expect(refusal('  RTSP://camera.local/live/ch00_0  ')).toBeNull();
    expect(refusal('rtsp://192.168.20.111/cam/realmonitor?channel=1&subtype=0')).toBeNull();
    expect(rtspUrlSchema.parse(' rtsp://10.0.0.5:554/stream2 ')).toBe(
      'rtsp://10.0.0.5:554/stream2',
    );
  });

  it('refuses credentials inside the address, so they never reach a screen or a log', () => {
    expect(refusal('rtsp://admin:secret@192.168.20.111:554/stream1')).toMatch(/own fields/);
    expect(refusal('rtsp://admin@192.168.20.111:554/stream1')).toMatch(/own fields/);
    expect(refusal('rtsp://:secret@192.168.20.111/stream1')).toMatch(/own fields/);
    expect(refusal('rtsp://192.168.20.111/stream1?user=admin&password=secret')).toMatch(
      /own field/,
    );
    expect(refusal('rtsp://192.168.20.111/stream1?pwd=secret')).toMatch(/own field/);
  });

  it('refuses anything that is not rtsp://', () => {
    expect(refusal('http://192.168.20.111/stream1')).toMatch(/rtsp:\/\//);
    expect(refusal('rtsps://192.168.20.111/stream1')).toMatch(/rtsp:\/\//);
    expect(refusal('file:///etc/passwd')).toMatch(/rtsp:\/\//);
    expect(refusal('-i rtsp://x/y')).toMatch(/spaces|rtsp/);
    expect(refusal('rtsp://')).not.toBeNull();
    expect(refusal('rtsp://192.168.20.111/stream 1')).toMatch(/spaces/);
    expect(refusal('rtsp://192.168.20.111/stream1\n-f')).toMatch(/spaces/);
    expect(refusal('rtsp://192.168.20.111/s#x')).toMatch(/#/);
    expect(refusal('')).not.toBeNull();
  });
});

describe('a camera’s settings', () => {
  const base = { name: 'Packing table', rtspUrl: 'rtsp://192.168.20.111:554/stream1' };

  it('takes a user name and a write-only password, and defaults to enabled', () => {
    expect(
      packingCameraCreateSchema.parse({ ...base, username: 'packing', password: 'p@ss:w0rd/#' }),
    ).toEqual({ ...base, username: 'packing', password: 'p@ss:w0rd/#', enabled: true });
    expect(packingCameraCreateSchema.parse(base)).toEqual({ ...base, username: '', enabled: true });
  });

  it('refuses a colon in the user name, control characters, and fields it does not know', () => {
    expect(packingCameraCreateSchema.safeParse({ ...base, username: 'a:b' }).success).toBe(false);
    expect(packingCameraCreateSchema.safeParse({ ...base, password: 'a\nb' }).success).toBe(false);
    expect(packingCameraCreateSchema.safeParse({ ...base, password: '' }).success).toBe(false);
    expect(packingCameraCreateSchema.safeParse({ ...base, secret: 'x' }).success).toBe(false);
  });

  it('keeps, replaces or removes the password on an update', () => {
    const update = { ...base, username: 'packing', enabled: false };
    expect(packingCameraUpdateSchema.parse(update).password).toBeUndefined();
    expect(packingCameraUpdateSchema.parse({ ...update, password: null }).password).toBeNull();
    expect(packingCameraUpdateSchema.parse({ ...update, password: 'new' }).password).toBe('new');
  });

  it('lets the station name its camera, or the desk’s own, when it opens an order', () => {
    const cameraId = '6b0f3a0e-8f0e-4c55-9d0b-2b4a1f2b7c11';
    expect(packingOpenSchema.parse({ code: 'ELY-1001', cameraId })).toEqual({
      code: 'ELY-1001',
      cameraId,
    });
    expect(packingOpenSchema.parse({ orderId: cameraId, cameraId: null })).toEqual({
      orderId: cameraId,
      cameraId: null,
    });
    expect(packingOpenSchema.parse({ code: 'ELY-1001' })).toEqual({ code: 'ELY-1001' });
    expect(packingOpenSchema.safeParse({ code: 'ELY-1001', cameraId: 'x' }).success).toBe(false);
  });
});

describe('an IP camera’s host (ledger audit W4)', () => {
  it('refuses the server’s own addresses, link-local, unspecified and one-word names', () => {
    for (const address of [
      'rtsp://127.0.0.1:554/stream1',
      'rtsp://127.10.0.5/stream1',
      'rtsp://localhost:554/stream1',
      'rtsp://camera.localhost/stream1',
      'rtsp://0.0.0.0/stream1',
      'rtsp://169.254.169.254/latest',
      'rtsp://[::1]:554/stream1',
      'rtsp://[::]/stream1',
      'rtsp://[fe80::1]/stream1',
      'rtsp://[::ffff:127.0.0.1]/stream1',
      'rtsp://valkey:6379/',
      'rtsp://postgres:5432/',
      'rtsp://api/',
      'rtsp://2130706433/stream1',
      'rtsp://0x7f.1/stream1',
      'rtsp://127.000.000.001/stream1',
      'rtsp://224.0.0.1/stream1',
    ]) {
      expect(refusal(address), address).not.toBeNull();
    }
    expect(refusal('rtsp://valkey:6379/')).toMatch(/one-word name/);
    expect(refusal('rtsp://169.254.169.254/latest')).toMatch(/link-local/);
  });

  it('allows the LAN ranges cameras live in, public addresses and full host names', () => {
    for (const address of [
      'rtsp://192.168.20.111:554/stream1',
      'rtsp://10.0.0.5/stream2',
      'rtsp://172.16.4.2/live',
      'rtsp://8.8.8.8/stream1',
      'rtsp://cam1.shop.example/stream1',
      'rtsp://[fd00::12]/stream1',
    ]) {
      expect(refusal(address), address).toBeNull();
    }
  });

  it('judges resolved addresses the same way (the camera process checks before it connects)', () => {
    expect(refusedCameraIp('127.0.0.1')).toBe('loopback');
    expect(refusedCameraIp('::1')).toBe('loopback');
    expect(refusedCameraIp('0:0:0:0:0:0:0:1')).toBe('loopback');
    expect(refusedCameraIp('169.254.1.1')).toBe('link-local');
    expect(refusedCameraIp('fe80::abcd')).toBe('link-local');
    expect(refusedCameraIp('::ffff:7f00:1')).toBe('an IPv4 address in IPv6 form');
    expect(refusedCameraIp('192.168.20.111')).toBeNull();
    expect(refusedCameraIp('2001:db8::1')).toBeNull();
    expect(cameraHostRefusal('cam1.shop.example.')).toBeNull();
    expect(PACKING_CAMERAS_MAX_ENABLED).toBe(8);
  });
});
