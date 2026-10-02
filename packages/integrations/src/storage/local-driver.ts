import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  StorageError,
  type PresignGetRequest,
  type PresignPutRequest,
  type SignedGet,
  type SignedPut,
  type StorageDriver,
  type StoredObject,
} from './driver.js';
import { assertValidKey } from './keys.js';
import { issueLocalToken, verifyLocalToken, type LocalTokenClaims } from './signing.js';

/**
 * The filesystem driver (architecture §22: "`local` driver, development and
 * tests").
 *
 * It is a real driver, not a stub, and the distinction matters: it expires its
 * URLs, refuses a forged key, records a content type and returns 404 for a key
 * that is not there. Those are the behaviours the module above it depends on, so
 * a suite that passes here is evidence about production rather than about a fake.
 *
 * What it deliberately does not do is enforce the byte ceiling on the wire. The
 * ceiling is enforced on ingest, by the route that receives the PUT, because
 * that is also the only place R2 can enforce it — see the note on
 * `SignedPut.maxBytes`. Having the two drivers differ there would hide the
 * real gap.
 */
export interface LocalDriverOptions {
  /** Where the bytes go. One directory per environment; never shared with a repo. */
  readonly root: string;
  /**
   * The absolute URL prefix the signed-content route is mounted at, e.g.
   * `https://erp.example.com/v1/files/content`. Absolute rather than a path
   * because the value is handed to a browser, and a relative URL would be
   * resolved against whatever page happened to be open.
   */
  readonly contentBaseUrl: string;
  /** Signs the tokens. The application secret, never a literal (invariant 10). */
  readonly secret: string;
}

export class LocalStorageDriver implements StorageDriver {
  readonly kind = 'local' as const;

  constructor(private readonly options: LocalDriverOptions) {
    if (options.secret.length < 32) {
      throw new Error('LocalStorageDriver needs a signing secret of at least 32 characters.');
    }
  }

  /**
   * The absolute path for a key, resolved and then *checked*.
   *
   * The key has already been through `assertValidKey`, which rejects `..`. This
   * check is the second one, and it is not redundant: it is the invariant
   * ("nothing outside the root") rather than a rule that happens to imply it, so
   * a future loosening of the key pattern cannot turn into an arbitrary write
   * without failing here first.
   */
  private pathFor(key: string): string {
    assertValidKey(key);
    const root = path.resolve(this.options.root);
    const resolved = path.resolve(root, key);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new StorageError('key-invalid', 'Storage key escapes the storage root.');
    }
    return resolved;
  }

  private expiry(seconds: number): { at: Date; epoch: number } {
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 86_400) {
      throw new StorageError('key-invalid', 'A signed URL must expire within 1..86400 seconds.');
    }
    const at = new Date(Date.now() + seconds * 1000);
    return { at, epoch: Math.floor(at.getTime() / 1000) };
  }

  /**
   * The signed URL: the token goes in the query string, not the path.
   *
   * A path segment would be the tidier URL and it does not work. The token is
   * a base64url claim set plus a 43-character signature — around 180
   * characters — and Fastify's router caps a single parameter at 100 by
   * default, so every download answered 414 URI Too Long before any handler
   * ran. Raising `maxParamLength` on the adapter would fix it for this route
   * and quietly raise the ceiling for every other route's parameters too.
   *
   * Query strings have no such cap, and the token is already base64url, so it
   * needs no escaping.
   */
  private url(claims: LocalTokenClaims): string {
    const token = issueLocalToken(this.options.secret, claims);
    return `${this.options.contentBaseUrl.replace(/\/+$/, '')}?t=${token}`;
  }

  // `async` rather than a sync function returning `Promise.resolve`: the
  // validation below throws, and a method that sometimes throws synchronously
  // and sometimes rejects makes every caller's error handling conditional on
  // which branch it took. A test caught it — `rejects` never saw the throw.
  async presignPut(request: PresignPutRequest): Promise<SignedPut> {
    assertValidKey(request.key);
    const { at, epoch } = this.expiry(request.expiresInSeconds);
    return await Promise.resolve({
      url: this.url({
        key: request.key,
        method: 'PUT',
        expiresAt: epoch,
        contentType: request.contentType,
      }),
      method: 'PUT',
      headers: { 'content-type': request.contentType },
      expiresAt: at,
      maxBytes: request.maxBytes,
    });
  }

  async presignGet(request: PresignGetRequest): Promise<SignedGet> {
    assertValidKey(request.key);
    const { at, epoch } = this.expiry(request.expiresInSeconds);
    return await Promise.resolve({
      url: this.url({
        key: request.key,
        method: 'GET',
        expiresAt: epoch,
        downloadFilename: request.downloadFilename,
      }),
      expiresAt: at,
    });
  }

  /**
   * The content type, kept beside the bytes.
   *
   * A sidecar file rather than an extended attribute or a guess from the
   * extension: xattrs are not portable to the Windows machines this repo is
   * developed on, and guessing from the extension would make the local driver
   * disagree with R2 about what an object is — which is precisely the kind of
   * difference that makes a local pass meaningless.
   */
  private static metaPath(file: string): string {
    return `${file}.content-type`;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    await writeFile(LocalStorageDriver.metaPath(file), contentType, 'utf8');
  }

  async get(key: string, options: { readonly maxBytes?: number } = {}): Promise<Uint8Array> {
    try {
      if (options.maxBytes === undefined) return new Uint8Array(await readFile(this.pathFor(key)));
      return await readCapped(this.pathFor(key), options.maxBytes);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        throw new StorageError('not-found', 'No such stored object.');
      }
      throw error;
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    const file = this.pathFor(key);
    try {
      const stats = await stat(file);
      let contentType = 'application/octet-stream';
      try {
        contentType = (await readFile(LocalStorageDriver.metaPath(file), 'utf8')).trim();
      } catch {
        // A file written by an older run, or by a presigned PUT that stored no
        // sidecar. The octet-stream default is the safe reading: a browser
        // downloads it rather than rendering it.
      }
      return { sizeBytes: stats.size, contentType };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    const file = this.pathFor(key);
    await rm(file, { force: true });
    await rm(LocalStorageDriver.metaPath(file), { force: true });
  }

  /**
   * What a signed token permits, for the route that serves the bytes.
   *
   * On the driver rather than free-standing so the route never sees the signing
   * secret: it holds a driver, asks it what a token means, and gets a refusal or
   * a key. A route that verified tokens itself would be a second implementation
   * of the same check, and the two would eventually disagree about expiry.
   */
  verify(token: string, now: Date = new Date()): LocalTokenClaims {
    return verifyLocalToken(this.options.secret, token, now);
  }
}

/**
 * Read a file, failing as soon as it passes `maxBytes` (D-417).
 *
 * In chunks rather than `stat` then `readFile`: a size checked first and read second is
 * exactly the gap B1 named, because the file can be replaced in between.
 */
async function readCapped(file: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new StorageError(
          'too-large',
          `The stored object is larger than ${String(maxBytes)} bytes.`,
        );
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  } finally {
    await handle.close();
  }
}
