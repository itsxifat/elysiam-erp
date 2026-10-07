import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StorageError } from './driver.js';
import { assertValidKey, buildStorageKey, variantKey } from './keys.js';
import { assertWithinLimit, mimeRuleFor, sniffMime } from './limits.js';
import { LocalStorageDriver } from './local-driver.js';
import { R2StorageDriver } from './r2-driver.js';
import { issueLocalToken, verifyLocalToken } from './signing.js';

const SECRET = 'a-storage-signing-secret-at-least-32-chars';

async function driver(): Promise<LocalStorageDriver> {
  const root = await mkdtemp(path.join(tmpdir(), 'elysium-storage-'));
  return new LocalStorageDriver({
    root,
    contentBaseUrl: 'https://erp.example.com/v1/files/content',
    secret: SECRET,
  });
}

function failureOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof StorageError) return error.failure;
    throw error;
  }
  throw new Error('expected the storage layer to refuse this');
}

describe('storage keys', () => {
  it('refuses traversal, absolute paths and empty segments', () => {
    expect(failureOf(() => assertValidKey('private/../../etc/passwd'))).toBe('key-invalid');
    expect(failureOf(() => assertValidKey('/private/a'))).toBe('key-invalid');
    expect(failureOf(() => assertValidKey('private//a'))).toBe('key-invalid');
    expect(failureOf(() => assertValidKey('private/a/'))).toBe('key-invalid');
  });

  /*
   * `#` truncates a URL path and `?` starts its query, so a key containing
   * either lands somewhere other than where the row says — silently, with
   * nothing reporting it. That is why the pattern is an allow-list.
   */
  it('refuses characters that change meaning inside a URL', () => {
    expect(failureOf(() => assertValidKey('private/a#b'))).toBe('key-invalid');
    expect(failureOf(() => assertValidKey('private/a?b'))).toBe('key-invalid');
    expect(failureOf(() => assertValidKey('private/a b'))).toBe('key-invalid');
  });

  it('never puts the uploaded filename in the key', () => {
    const key = buildStorageKey({
      visibility: 'private',
      orgId: '0e6c1c9e-0000-4000-8000-000000000001',
      fileId: '8f14e45f-0000-4000-8000-000000000002',
      extension: 'pdf',
      now: new Date('2026-03-09T00:00:00Z'),
    });
    expect(key).toBe(
      'private/0e6c1c9e-0000-4000-8000-000000000001/2026/03/8f14e45f-0000-4000-8000-000000000002.pdf',
    );
  });

  it('puts a variant beside its original so deleting the prefix takes both', () => {
    expect(variantKey('public/org/2026/03/abc.jpg', 'thumb', 'webp')).toBe(
      'public/org/2026/03/abc.thumb.webp',
    );
  });
});

describe('upload limits', () => {
  it('accepts a declared type with parameters and odd casing', () => {
    expect(mimeRuleFor('IMAGE/JPEG; charset=binary').extension).toBe('jpg');
  });

  it('refuses the types that turn a bucket into a script host', () => {
    expect(failureOf(() => mimeRuleFor('image/svg+xml'))).toBe('mime-rejected');
    expect(failureOf(() => mimeRuleFor('text/html'))).toBe('mime-rejected');
    expect(failureOf(() => mimeRuleFor('application/xhtml+xml'))).toBe('mime-rejected');
  });

  it('enforces the per-type ceiling, not one global one', () => {
    const jpeg = mimeRuleFor('image/jpeg');
    const pdf = mimeRuleFor('application/pdf');
    expect(pdf.maxBytes).toBeGreaterThan(jpeg.maxBytes);
    expect(failureOf(() => assertWithinLimit(jpeg.maxBytes + 1, jpeg))).toBe('too-large');
    expect(failureOf(() => assertWithinLimit(0, jpeg))).toBe('too-large');
    expect(() => assertWithinLimit(jpeg.maxBytes, jpeg)).not.toThrow();
  });

  /*
   * The declared type is what the client said; this is what arrived. HTML
   * declared as image/png is the attack: the download endpoint sets
   * Content-Type from the row, so a browser would render it as a page on our
   * own origin.
   */
  it('sniffs what the bytes really are', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(new TextEncoder().encode('<!doctype html>'))).toBeNull();
  });

  /** M38b (D-613): what a browser's recorder writes, and the stills that share the boxes. */
  it('tells a recorded WebM or MP4 from an image in the same container', () => {
    const box = (brand: string) =>
      new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode(`ftyp${brand}`), 0, 0, 0, 0]);
    expect(sniffMime(box('isom'))).toBe('video/mp4');
    expect(sniffMime(box('iso5'))).toBe('video/mp4');
    expect(sniffMime(box('mp42'))).toBe('video/mp4');
    expect(sniffMime(box('avif'))).toBe('image/avif');
    expect(sniffMime(box('heic'))).toBeNull();
    const ebml = (docType: string) =>
      new Uint8Array([
        0x1a,
        0x45,
        0xdf,
        0xa3,
        0x9f,
        0x42,
        0x86,
        0x81,
        0x01,
        0x42,
        0x82,
        0x84,
        ...new TextEncoder().encode(docType),
      ]);
    expect(sniffMime(ebml('webm'))).toBe('video/webm');
    expect(sniffMime(ebml('matroska'))).toBeNull();
  });

  it('keeps videos to their own ceiling, above a document’s and under one request through Cloudflare', () => {
    const webm = mimeRuleFor('video/webm;codecs=vp8');
    expect(webm.isVideo).toBe(true);
    expect(webm.maxBytes).toBe(90 * 1024 * 1024);
    expect(webm.maxBytes).toBeLessThan(100_000_000);
    expect(mimeRuleFor('video/mp4').isVideo).toBe(true);
    expect(mimeRuleFor('application/pdf').isVideo).toBeUndefined();
    expect(() => mimeRuleFor('video/quicktime')).toThrow();
  });
});

describe('the local driver', () => {
  it('round-trips bytes and remembers the content type', async () => {
    const local = await driver();
    const key = 'private/org/2026/03/a.pdf';
    await local.put(key, new TextEncoder().encode('%PDF-1.7'), 'application/pdf');

    expect(new TextDecoder().decode(await local.get(key))).toBe('%PDF-1.7');
    expect(await local.head(key)).toEqual({ sizeBytes: 8, contentType: 'application/pdf' });
  });

  it('stops a capped read as soon as it passes the ceiling (D-417)', async () => {
    const local = await driver();
    const key = 'private/org/2026/03/big.pdf';
    await local.put(key, new Uint8Array(200 * 1024).fill(0x41), 'application/pdf');

    await expect(local.get(key, { maxBytes: 100 * 1024 })).rejects.toMatchObject({
      failure: 'too-large',
    });
    expect((await local.get(key, { maxBytes: 200 * 1024 })).byteLength).toBe(200 * 1024);
    expect((await local.get(key)).byteLength).toBe(200 * 1024);
  });

  it('reports a missing object rather than inventing one', async () => {
    const local = await driver();
    expect(await local.head('private/org/2026/03/missing.pdf')).toBeNull();
    await expect(local.get('private/org/2026/03/missing.pdf')).rejects.toMatchObject({
      failure: 'not-found',
    });
  });

  /*
   * The second line of defence. `assertValidKey` already rejects `..`, so this
   * asserts the invariant itself — nothing outside the root — which is what has
   * to hold if the key pattern is ever loosened.
   */
  it('refuses a key that would escape the storage root', async () => {
    const local = await driver();
    await expect(local.put('../escaped', new Uint8Array([1]), 'text/csv')).rejects.toMatchObject({
      failure: 'key-invalid',
    });
  });

  it('signs a GET that expires, and says when', async () => {
    const local = await driver();
    const signed = await local.presignGet({
      key: 'private/org/2026/03/a.pdf',
      expiresInSeconds: 60,
    });

    expect(signed.url.startsWith('https://erp.example.com/v1/files/content?t=')).toBe(true);
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);

    const token = new URL(signed.url).searchParams.get('t') ?? '';
    expect(local.verify(token).key).toBe('private/org/2026/03/a.pdf');
  });

  it('refuses an expiry outside 1..86400 seconds, so no URL outlives a day', async () => {
    const local = await driver();
    await expect(
      local.presignGet({ key: 'private/org/2026/03/a.pdf', expiresInSeconds: 0 }),
    ).rejects.toMatchObject({ failure: 'key-invalid' });
    await expect(
      local.presignGet({ key: 'private/org/2026/03/a.pdf', expiresInSeconds: 86_401 }),
    ).rejects.toMatchObject({ failure: 'key-invalid' });
  });

  it('writes the sidecar beside the object, not inside it', async () => {
    const local = await driver();
    const key = 'public/org/2026/03/a.webp';
    await local.put(key, new Uint8Array([1, 2, 3]), 'image/webp');
    // Reading back through head() would pass even if the type were stored in the
    // file itself, so the bytes are checked directly.
    const root = (local as unknown as { options: { root: string } }).options.root;
    expect(await readFile(path.join(root, key))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('removes an object and its sidecar', async () => {
    const local = await driver();
    const key = 'private/org/2026/03/a.pdf';
    await local.put(key, new Uint8Array([1]), 'application/pdf');
    await local.remove(key);
    expect(await local.head(key)).toBeNull();
  });
});

describe('local signed tokens', () => {
  it('refuses a token whose key was edited', () => {
    const token = issueLocalToken(SECRET, {
      key: 'private/org/2026/03/mine.pdf',
      method: 'GET',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    const [body, signature] = token.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({
        key: 'private/other-org/2026/03/theirs.pdf',
        method: 'GET',
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
      'utf8',
    ).toString('base64url');

    expect(body).not.toBe(forgedBody);
    expect(failureOf(() => verifyLocalToken(SECRET, `${forgedBody}.${String(signature)}`))).toBe(
      'signature-invalid',
    );
  });

  it('refuses a token signed with another secret', () => {
    const token = issueLocalToken('a-different-secret-of-at-least-32-characters', {
      key: 'private/org/2026/03/a.pdf',
      method: 'GET',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    expect(failureOf(() => verifyLocalToken(SECRET, token))).toBe('signature-invalid');
  });

  it('refuses an expired token, and says so rather than saying it is invalid', () => {
    const token = issueLocalToken(SECRET, {
      key: 'private/org/2026/03/a.pdf',
      method: 'GET',
      expiresAt: Math.floor(Date.now() / 1000) + 5,
    });
    expect(verifyLocalToken(SECRET, token).key).toBe('private/org/2026/03/a.pdf');
    expect(failureOf(() => verifyLocalToken(SECRET, token, new Date(Date.now() + 6000)))).toBe(
      'expired',
    );
  });

  /*
   * The fields are length-prefixed before they are hashed. Without that, a key
   * ending in a newline could absorb the method field and two different claim
   * sets would share one signature.
   */
  it('does not let one field bleed into the next', () => {
    const a = issueLocalToken(SECRET, { key: 'a\nGET', method: 'PUT', expiresAt: 1 });
    const b = issueLocalToken(SECRET, { key: 'a', method: 'GET', expiresAt: 1 });
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
  });

  it('refuses a token with no signature at all', () => {
    expect(failureOf(() => verifyLocalToken(SECRET, 'not-a-token'))).toBe('signature-invalid');
  });
});

describe('the r2 driver', () => {
  const r2 = () =>
    new R2StorageDriver({
      accountId: 'acct',
      bucket: 'elysium',
      accessKeyId: 'k',
      secretAccessKey: 's',
      publicBaseUrl: 'https://cdn.example.com',
    });

  it('presigns against the documented R2 endpoint, path style, region auto', async () => {
    const signed = await r2().presignGet({
      key: 'private/org/2026/03/a.pdf',
      expiresInSeconds: 300,
    });
    const url = new URL(signed.url);

    expect(url.host).toBe('acct.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/elysium/private/org/2026/03/a.pdf');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the content type into a PUT ticket', async () => {
    const ticket = await r2().presignPut({
      key: 'public/org/2026/03/a.webp',
      contentType: 'image/webp',
      maxBytes: 1024,
      expiresInSeconds: 300,
    });
    expect(ticket.method).toBe('PUT');
    expect(ticket.headers['content-type']).toBe('image/webp');
    expect(new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });

  it('forces a download filename through response-content-disposition', async () => {
    const signed = await r2().presignGet({
      key: 'private/org/2026/03/a.pdf',
      expiresInSeconds: 60,
      downloadFilename: 'invoice-1001.pdf',
    });
    expect(new URL(signed.url).searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="invoice-1001.pdf"',
    );
  });

  it('strips quotes from a download filename so it cannot add header parameters', async () => {
    const signed = await r2().presignGet({
      key: 'private/org/2026/03/a.pdf',
      expiresInSeconds: 60,
      downloadFilename: 'a".pdf"; x=y',
    });
    expect(new URL(signed.url).searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="a.pdf; x=y"',
    );
  });

  /*
   * A permanent CDN URL for a private object would be a leak that no expiry
   * covers, so the prefix is checked rather than assumed.
   */
  it('refuses a CDN URL for anything not under public/', () => {
    expect(r2().publicUrl('public/org/2026/03/a.webp')).toBe(
      'https://cdn.example.com/public/org/2026/03/a.webp',
    );
    expect(failureOf(() => r2().publicUrl('private/org/2026/03/a.pdf'))).toBe('key-invalid');
  });

  it('never puts a signed URL into an error message', async () => {
    const failing = new R2StorageDriver({
      accountId: 'acct',
      bucket: 'elysium',
      accessKeyId: 'k',
      secretAccessKey: 'super-secret',
      fetchImpl: () => Promise.resolve(new Response('denied', { status: 403 })),
    });

    await expect(
      failing.put('private/org/2026/03/a.pdf', new Uint8Array([1]), 'application/pdf'),
    ).rejects.toMatchObject({ failure: 'driver-unavailable' });

    try {
      await failing.get('private/org/2026/03/a.pdf');
    } catch (error) {
      expect((error as Error).message).not.toContain('X-Amz-Signature');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });

  it('caps a read whatever the length header says, and cancels the stream (D-417)', async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024).fill(0x41));
        },
        cancel() {
          cancelled = true;
        },
      });
    const lying = new R2StorageDriver({
      accountId: 'acct',
      bucket: 'elysium',
      accessKeyId: 'k',
      secretAccessKey: 's',
      // No length header at all: only counting the bytes can stop this.
      fetchImpl: () => Promise.resolve(new Response(endless(), { status: 200 })),
    });

    await expect(
      lying.get('private/org/2026/03/a.pdf', { maxBytes: 8 * 1024 }),
    ).rejects.toMatchObject({ failure: 'too-large' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(20);

    const honest = new R2StorageDriver({
      accountId: 'acct',
      bucket: 'elysium',
      accessKeyId: 'k',
      secretAccessKey: 's',
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array(3000).fill(0x42), {
            status: 200,
            headers: { 'content-length': '3000' },
          }),
        ),
    });
    expect((await honest.get('private/org/2026/03/a.pdf', { maxBytes: 3000 })).byteLength).toBe(
      3000,
    );
    await expect(honest.get('private/org/2026/03/a.pdf', { maxBytes: 2999 })).rejects.toMatchObject(
      { failure: 'too-large' },
    );
  });

  it('treats a missing object as missing and a missing delete as done', async () => {
    const missing = new R2StorageDriver({
      accountId: 'acct',
      bucket: 'elysium',
      accessKeyId: 'k',
      secretAccessKey: 's',
      fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
    });

    expect(await missing.head('private/org/2026/03/a.pdf')).toBeNull();
    await expect(missing.get('private/org/2026/03/a.pdf')).rejects.toMatchObject({
      failure: 'not-found',
    });
    await expect(missing.remove('private/org/2026/03/a.pdf')).resolves.toBeUndefined();
  });
});

afterEach(() => {
  // Temp directories are left for the OS to reap: removing them would add a
  // failure mode (a Windows file lock) to tests that are not about cleanup.
});
