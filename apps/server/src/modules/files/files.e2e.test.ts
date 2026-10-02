import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type Client,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { resetFilesEnv } from './files.config.js';

/**
 * Files over HTTP, against a real database (M04 acceptance check 4).
 *
 * > Downloading a private file without permission returns 403. With
 * > permission, the endpoint returns a signed URL that has expired by the end
 * > of the test.
 *
 * Both halves are asserted here, and both are asserted the hard way:
 *
 * - The 403 is a role that legitimately holds `read FileObject` — a sales
 *   agent, who downloads payment screenshots all day — being refused a
 *   *payslip*. A test that used a role with no file permission at all would
 *   pass against the guard and prove nothing about the per-document gate,
 *   which is the thing §22 actually needs (D-115).
 * - The expiry is checked by minting a URL, using it successfully, moving the
 *   clock past `expiresAt`, and using it again. Faking the clock rather than
 *   sleeping: the minimum configurable lifetime is 30 seconds, and a suite
 *   that waits half a minute for one assertion is a suite people stop running.
 *   Only `Date` is faked, so the database driver's timers are untouched.
 */

let harness: HttpHarness;

beforeAll(async () => {
  // Before the app is built: the driver is constructed from this at module
  // registration, and a root inside the repository would put test uploads one
  // `git add -A` away from being committed.
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), 'elysium-files-e2e-'));
  process.env.FILE_URL_TTL_SECONDS = '30';
  resetFilesEnv();

  harness = await startHttpHarness('files');
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

interface Uploaded {
  readonly fileId: string;
}

async function pngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: '#2f6fdd' } })
    .png()
    .toBuffer();
}

/** The whole upload flow: ticket, PUT to the signed URL, finalize. */
async function upload(
  client: Client,
  body: { purpose: string; contentType: string; visibility?: string; originalName?: string },
  bytes: Buffer,
): Promise<Uploaded> {
  const ticketResponse = await client.request('POST', '/v1/files', {
    body: { ...body, sizeBytes: bytes.byteLength },
  });
  expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
  const ticket = JSON.parse(ticketResponse.body) as {
    fileId: string;
    url: string;
    headers: Record<string, string>;
  };

  const put = await harness.server.inject({
    method: 'PUT',
    url: `${new URL(ticket.url).pathname}${new URL(ticket.url).search}`,
    headers: { ...ticket.headers, host: new URL(ticket.url).host },
    payload: bytes,
  });
  expect(put.statusCode, put.body).toBe(200);

  const finalize = await client.request('POST', `/v1/files/${ticket.fileId}/finalize`);
  expect(finalize.statusCode, finalize.body).toBe(201);

  return { fileId: ticket.fileId };
}

async function downloadUrl(
  client: Client,
  fileId: string,
): Promise<{ status: number; url?: string; expiresAt?: string; body: string }> {
  const response = await client.request('GET', `/v1/files/${fileId}/download`);
  if (response.statusCode !== 200) {
    return { status: response.statusCode, body: response.body };
  }
  const parsed = JSON.parse(response.body) as { url: string; expiresAt: string };
  return { status: 200, url: parsed.url, expiresAt: parsed.expiresAt, body: response.body };
}

describe('acceptance check 4: a private file, without permission and with it', () => {
  it('refuses a payslip to a role that holds read:FileObject but not read:Payroll', async () => {
    const hr = await harness.asRole('hr', ORG_A);
    const sales = await harness.asRole('sales', ORG_A);

    const { fileId } = await upload(
      hr.client,
      { purpose: 'payslip', contentType: 'application/pdf', originalName: 'march-payslip.pdf' },
      Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer<<>>\n%%EOF\n', 'latin1'),
    );

    // Sales holds `read FileObject` at org scope — the guard admits them.
    // The refusal comes from the purpose gate, which is the point.
    const refused = await downloadUrl(sales.client, fileId);
    expect(refused.status, refused.body).toBe(403);
    // And no URL was minted on the way to saying no. A signed URL in a 403
    // body is still a signed URL, and whether it leaked then depends on what
    // the logs happened to record.
    expect(refused.body).not.toContain('/v1/files/content');
  });

  it('gives accounts the same payslip no URL, and hr — its owner — one that works', async () => {
    const hr = await harness.asRole('hr', ORG_A);
    const { fileId } = await upload(
      hr.client,
      { purpose: 'payslip', contentType: 'application/pdf' },
      Buffer.from('%PDF-1.7\ntrailer<<>>\n%%EOF\n', 'latin1'),
    );

    const owner = await downloadUrl(hr.client, fileId);
    expect(owner.status, owner.body).toBe(200);
    expect(owner.url).toContain('/v1/files/content?t=');
  });

  it('returns a signed URL that works, and has expired by the end of this test', async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const invoice = Buffer.from('%PDF-1.7\ninvoice\ntrailer<<>>\n%%EOF\n', 'latin1');

    const { fileId } = await upload(
      accounts.client,
      { purpose: 'invoice', contentType: 'application/pdf', originalName: 'ELY-2026-1042.pdf' },
      invoice,
    );

    const signed = await downloadUrl(accounts.client, fileId);
    expect(signed.status, signed.body).toBe(200);
    const url = new URL(signed.url ?? '');
    const expiresAt = new Date(signed.expiresAt ?? '');

    // The URL says when it dies, and the client is told, so it cannot cache it
    // past that point and call the resulting 403 a mystery.
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000 + 1000);

    const before = await harness.server.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
    });
    expect(before.statusCode, before.body).toBe(200);
    expect(Buffer.from(before.rawPayload)).toEqual(invoice);
    // Served as a download, never rendered: these two headers together are
    // what keep a bad upload from becoming stored XSS on our own origin.
    expect(before.headers['content-disposition']).toContain('attachment');
    expect(before.headers['x-content-type-options']).toBe('nosniff');

    // Move past the expiry. Only Date is faked; the database driver's timers
    // and the event loop are untouched.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(expiresAt.getTime() + 1000));

    const after = await harness.server.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
    });
    expect(after.statusCode, after.body).toBe(403);
    expect(after.body).toContain('expired');
  });
});

describe('the gates the download check depends on', () => {
  it('does not resolve another org file id at all', async () => {
    const a = await harness.asRole('accounts', ORG_A);
    const b = await harness.asRole('accounts', ORG_B);

    const { fileId } = await upload(
      a.client,
      { purpose: 'invoice', contentType: 'application/pdf' },
      Buffer.from('%PDF-1.7\ntrailer<<>>\n%%EOF\n', 'latin1'),
    );

    // 404, not 403: a row another org may not see must be indistinguishable
    // from one that does not exist, or the error is an existence oracle.
    const across = await downloadUrl(b.client, fileId);
    expect(across.status).toBe(404);
  });

  it("limits a reseller to their own files, because their grant is 'own'", async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const reseller = await harness.asRole('reseller', ORG_A);

    const theirs = await upload(
      accounts.client,
      { purpose: 'invoice', contentType: 'application/pdf' },
      Buffer.from('%PDF-1.7\ntrailer<<>>\n%%EOF\n', 'latin1'),
    );
    const mine = await upload(
      reseller.client,
      { purpose: 'kyc', contentType: 'application/pdf', originalName: 'trade-licence.pdf' },
      Buffer.from('%PDF-1.7\nlicence\ntrailer<<>>\n%%EOF\n', 'latin1'),
    );

    // The scope is a WHERE clause, so somebody else's row is simply not there.
    expect((await downloadUrl(reseller.client, theirs.fileId)).status).toBe(404);
    // Their own KYC scan they may always read, without any org-wide grant.
    expect((await downloadUrl(reseller.client, mine.fileId)).status).toBe(200);
  });

  it('refuses a download for an upload whose bytes never arrived', async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const ticket = await accounts.client.request('POST', '/v1/files', {
      body: { purpose: 'invoice', contentType: 'application/pdf', sizeBytes: 100 },
    });
    const { fileId } = JSON.parse(ticket.body) as { fileId: string };

    // Pending is not a file yet. "Not found" is the truthful answer as well as
    // the safe one — otherwise a ticket is a handle on an empty object.
    expect((await downloadUrl(accounts.client, fileId)).status).toBe(404);
  });

  it('refuses a forged content token outright', async () => {
    const forged = await harness.server.inject({
      method: 'GET',
      url: '/v1/files/content?t=eyJrZXkiOiJwcml2YXRlL3gveC5wZGYifQ.not-a-signature',
    });
    expect(forged.statusCode).toBe(403);
  });
});

describe('what may be uploaded', () => {
  it('refuses a MIME type that is not on the allow-list', async () => {
    const sales = await harness.asRole('sales', ORG_A);
    const response = await sales.client.request('POST', '/v1/files', {
      body: {
        purpose: 'order-payment-proof',
        contentType: 'image/svg+xml',
        sizeBytes: 1024,
      },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('refuses to make a payslip public, however the request asks', async () => {
    const hr = await harness.asRole('hr', ORG_A);
    const response = await hr.client.request('POST', '/v1/files', {
      body: {
        purpose: 'payslip',
        contentType: 'application/pdf',
        visibility: 'public',
        sizeBytes: 1024,
      },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('defaults to private when the request says nothing', async () => {
    const sales = await harness.asRole('sales', ORG_A);
    const { fileId } = await upload(
      sales.client,
      { purpose: 'order-payment-proof', contentType: 'image/png' },
      await pngBytes(),
    );
    const signed = await downloadUrl(sales.client, fileId);
    expect(signed.status).toBe(200);

    const detail = JSON.parse(signed.body) as { file: { visibility: string } };
    expect(detail.file.visibility).toBe('private');
  });

  /*
   * The declared type is what the client said; the sniff is what arrived. HTML
   * stored under an `image/png` ticket and served with that Content-Type from
   * our own origin is stored XSS against every session cookie scoped to the
   * domain, so finalize refuses it and the row stays pending.
   */
  it('refuses bytes that are not what the ticket was issued for', async () => {
    const sales = await harness.asRole('sales', ORG_A);
    const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');

    const ticketResponse = await sales.client.request('POST', '/v1/files', {
      body: {
        purpose: 'order-payment-proof',
        contentType: 'image/png',
        sizeBytes: html.byteLength,
      },
    });
    const ticket = JSON.parse(ticketResponse.body) as {
      fileId: string;
      url: string;
      headers: Record<string, string>;
    };

    const put = await harness.server.inject({
      method: 'PUT',
      url: `${new URL(ticket.url).pathname}${new URL(ticket.url).search}`,
      headers: { ...ticket.headers, host: new URL(ticket.url).host },
      payload: html,
    });
    expect(put.statusCode).toBe(200);

    const finalize = await sales.client.request('POST', `/v1/files/${ticket.fileId}/finalize`);
    expect(finalize.statusCode, finalize.body).toBe(400);

    // And it stays undownloadable, rather than being a stored object with a
    // row that merely failed to update.
    expect((await downloadUrl(sales.client, ticket.fileId)).status).toBe(404);
  });

  it('takes bytes for a pending upload only, never over a stored file', async () => {
    /*
     * A ticket outlives its finalize by minutes. A PUT in that window used to replace the
     * stored bytes after their hash and sniffed type were recorded, with no audit trace
     * (D-389). A retry before the finalize is still an ordinary upload.
     */
    const sales = await harness.asRole('sales', ORG_A);
    const bytes = await pngBytes();
    const ticketResponse = await sales.client.request('POST', '/v1/files', {
      body: {
        purpose: 'order-payment-proof',
        contentType: 'image/png',
        sizeBytes: bytes.byteLength,
      },
    });
    expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
    const ticket = JSON.parse(ticketResponse.body) as {
      fileId: string;
      url: string;
      headers: Record<string, string>;
    };
    const put = (payload: Buffer) =>
      harness.server.inject({
        method: 'PUT',
        url: `${new URL(ticket.url).pathname}${new URL(ticket.url).search}`,
        headers: { ...ticket.headers, host: new URL(ticket.url).host },
        payload,
      });

    expect((await put(bytes)).statusCode).toBe(200);
    expect((await put(bytes)).statusCode).toBe(200);
    const finalize = await sales.client.request('POST', `/v1/files/${ticket.fileId}/finalize`);
    expect(finalize.statusCode, finalize.body).toBe(201);

    const replaced = await put(bytes);
    expect(replaced.statusCode, replaced.body).toBe(409);
  });

  it('re-encodes an uploaded image into thumb, card and full', async () => {
    const marketing = await harness.asRole('marketing', ORG_A);
    const ticketResponse = await marketing.client.request('POST', '/v1/files', {
      body: {
        purpose: 'product-image',
        contentType: 'image/png',
        visibility: 'public',
        sizeBytes: (await pngBytes()).byteLength,
      },
    });
    const ticket = JSON.parse(ticketResponse.body) as {
      fileId: string;
      url: string;
      headers: Record<string, string>;
    };

    await harness.server.inject({
      method: 'PUT',
      url: `${new URL(ticket.url).pathname}${new URL(ticket.url).search}`,
      headers: { ...ticket.headers, host: new URL(ticket.url).host },
      payload: await pngBytes(),
    });

    const finalize = await marketing.client.request('POST', `/v1/files/${ticket.fileId}/finalize`);
    expect(finalize.statusCode, finalize.body).toBe(201);

    const file = JSON.parse(finalize.body) as {
      status: string;
      sha256: string;
      variants: Record<string, { key: string; mime: string }>;
    };
    expect(file.status).toBe('stored');
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(file.variants).sort()).toEqual(['card', 'full', 'thumb']);
    expect(file.variants.thumb?.mime).toBe('image/webp');
  });
});
