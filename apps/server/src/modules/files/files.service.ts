import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { defineAbilityFor } from '@elysium/contracts';
import {
  StorageError,
  assertWithinLimit,
  buildStorageKey,
  mimeRuleFor,
  sniffMime,
  variantKey,
  type StorageDriver,
} from '@elysium/integrations';

import type { ActiveContext } from '../../platform/http/context.js';
import { isProcessableImage, processImage, ImageRejected } from './image.js';
import { PURPOSE_RULES, type FilePurpose } from './files.policy.js';
import type { UploadTicketInput } from './files.schemas.js';
import {
  findById,
  insertPending,
  markStored,
  recordVariants,
  statusByKey,
  type FileRow,
} from './files.repository.js';

/**
 * Uploads and downloads (architecture §22).
 *
 * The rule this service exists to hold is one sentence: **authorize before you
 * sign**. A signed URL is a bearer token — once it exists it works for whoever
 * holds it, for as long as it lasts, and no later check can take it back. So
 * the permission decision happens against the row, before the driver is asked
 * for a URL, and the one function that can produce a download URL is the one
 * that made that decision.
 *
 * The opposite arrangement — sign first, check on the way out — is the shape
 * most file APIs have, and it is wrong in a way that does not show up in
 * testing: the 403 is returned, the URL is already minted, and whether it
 * leaked depends on what the logging middleware happened to record.
 */

export interface SignedDownload {
  readonly url: string;
  readonly expiresAt: Date;
  readonly file: PublicFile;
}

/** What a file looks like to a caller. Deliberately not the row. */
export interface PublicFile {
  readonly id: string;
  readonly purpose: string;
  readonly visibility: 'private' | 'public';
  readonly status: 'pending' | 'stored';
  readonly mime: string;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly originalName: string | null;
  readonly variants: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface UploadTicket {
  readonly fileId: string;
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
  readonly maxBytes: number;
}

function present(row: FileRow): PublicFile {
  return {
    id: row.id,
    purpose: row.purpose,
    visibility: row.visibility,
    status: row.status,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    originalName: row.originalName,
    variants: row.variants,
    createdAt: row.createdAt,
  };
}

/** Turn a storage refusal into the HTTP answer it deserves. */
/** The org segment of a storage key, as `buildStorageKey` writes it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapStorageError(error: unknown): never {
  if (error instanceof StorageError) {
    switch (error.failure) {
      case 'not-found':
        throw new NotFoundException(error.message);
      case 'mime-rejected':
      case 'too-large':
      case 'key-invalid':
        throw new BadRequestException(error.message);
      case 'expired':
      case 'signature-invalid':
        // 403 rather than 401: there is nothing to re-authenticate with. The
        // link itself is the credential, and it is spent.
        throw new ForbiddenException(error.message);
      case 'driver-unavailable':
        // Rethrown, so it surfaces as a 500 and is logged as one. It means the
        // object store answered badly, which is our problem rather than the
        // caller's — a 400 would send them looking at their own request for a
        // fault that is not in it.
        throw error;
    }
  }
  if (error instanceof ImageRejected) throw new BadRequestException(error.message);
  throw error;
}

@Injectable()
export class FilesService {
  constructor(
    private readonly driver: StorageDriver,
    private readonly ttlSeconds: number,
    private readonly uploadTtlSeconds: number,
  ) {}

  /**
   * Issue a presigned PUT and the row it will fill.
   *
   * The row first, then the URL, and both bounded before either: the MIME type
   * must be on the allow-list, the declared size must be under that type's
   * ceiling, and a purpose that may never be public cannot be made public. The
   * last one is the one worth stating — `visibility` arrives from the client,
   * and a client-supplied field that can make a payslip world-readable is not a
   * field, it is a typo waiting to happen.
   */
  async createUploadTicket(
    context: ActiveContext,
    input: UploadTicketInput,
  ): Promise<UploadTicket> {
    try {
      const rule = mimeRuleFor(input.contentType);
      assertWithinLimit(input.sizeBytes, rule);

      const purposeRule = PURPOSE_RULES[input.purpose];
      if (input.visibility === 'public' && !purposeRule.mayBePublic) {
        throw new BadRequestException(`A ${input.purpose} file cannot be public.`);
      }
      if (input.visibility === 'public' && !rule.isImage) {
        // The public bucket is served by the CDN with no authorization at all.
        // Only imagery belongs there; a "public PDF" is almost always somebody
        // reaching for the easy path with a document that should be signed.
        throw new BadRequestException('Only images may be stored in the public bucket.');
      }

      const fileId = randomUUID();
      const storageKey = buildStorageKey({
        visibility: input.visibility,
        orgId: context.orgId,
        fileId,
        extension: rule.extension,
      });

      await insertPending(
        { orgId: context.orgId, userId: context.userId },
        {
          id: fileId,
          storageKey,
          driver: this.driver.kind,
          visibility: input.visibility,
          purpose: input.purpose,
          ownerUserId: context.userId,
          mime: rule.mime,
          originalName: input.originalName ?? null,
        },
      );

      const ticket = await this.driver.presignPut({
        key: storageKey,
        contentType: rule.mime,
        maxBytes: rule.maxBytes,
        expiresInSeconds: this.uploadTtlSeconds,
      });

      return {
        fileId,
        url: ticket.url,
        method: ticket.method,
        headers: ticket.headers,
        expiresAt: ticket.expiresAt,
        maxBytes: ticket.maxBytes,
      };
    } catch (error) {
      return mapStorageError(error);
    }
  }

  /**
   * Confirm the bytes landed, and record what they actually are.
   *
   * This is where the client's claims stop mattering. The object is read back
   * from storage, hashed, measured and sniffed, and it is the *sniffed* type
   * that goes on the row — so the `Content-Type` the download endpoint later
   * serves is one the server decided. Without this step an uploader could store
   * HTML under an `image/png` ticket and have it rendered as a page on our own
   * origin, which is stored XSS against every session cookie scoped to the
   * domain.
   *
   * The size ceiling is enforced here too, and it has to be: neither driver can
   * bind a maximum to a presigned PUT. An over-sized object is refused and the
   * row stays `pending`, so nothing can download it.
   */
  async finalizeUpload(
    context: ActiveContext,
    fileId: string,
    scope: SqlLike,
  ): Promise<PublicFile> {
    const row = await this.load(context, fileId, scope);
    if (row.status === 'stored') return present(row);

    try {
      const bytes = await this.driver.get(row.storageKey);
      const rule = mimeRuleFor(row.mime);
      assertWithinLimit(bytes.byteLength, rule);

      const sniffed = sniffMime(bytes);
      /*
       * A type we cannot sniff is accepted only for the formats that genuinely
       * have no magic number — CSV is plain text. For everything else a
       * mismatch or an unrecognised header is a refusal, because the whole
       * point of this check is the case where the bytes are not what was
       * declared.
       */
      if (sniffed === null && rule.mime !== 'text/csv') {
        throw new BadRequestException('The uploaded bytes are not a file of the declared type.');
      }
      if (sniffed !== null && sniffed !== rule.mime) {
        throw new BadRequestException(
          `The uploaded bytes are ${sniffed}, not the ${rule.mime} the ticket was issued for.`,
        );
      }

      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await markStored(
        { orgId: context.orgId, userId: context.userId },
        { id: fileId, sizeBytes: bytes.byteLength, sha256, mime: sniffed ?? rule.mime },
      );

      if (rule.isImage && isProcessableImage(sniffed ?? rule.mime)) {
        await this.makeVariants(context, row.storageKey, fileId, bytes);
      }

      const refreshed = await this.load(context, fileId, scope);
      return present(refreshed);
    } catch (error) {
      return mapStorageError(error);
    }
  }

  /**
   * Re-encode into thumb/card/full and store them.
   *
   * Inline rather than through pg-boss, for now. The honest reason: this slice
   * does not own the job runner, and an image that is resized synchronously is
   * correct but slow, while one enqueued against a queue that is not wired yet
   * is neither. The work is already a pure function (`processImage`), so moving
   * it behind `enqueue(tx, …)` is a call-site change — logged as a follow-up.
   */
  private async makeVariants(
    context: ActiveContext,
    storageKey: string,
    fileId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const processed = await processImage(bytes, (variant) =>
      variantKey(storageKey, variant, 'webp'),
    );

    const recorded: Record<string, unknown> = {};
    for (const [name, variant] of Object.entries(processed.variants)) {
      await this.driver.put(variant.key, variant.bytes, variant.mime);
      recorded[name] = {
        key: variant.key,
        width: variant.width,
        height: variant.height,
        sizeBytes: variant.sizeBytes,
        mime: variant.mime,
        sha256: variant.sha256,
      };
    }

    await recordVariants({ orgId: context.orgId, userId: context.userId }, fileId, recorded);
  }

  /**
   * Authorize, then sign. In that order, and the order is the whole design.
   *
   * Three gates, narrowing:
   *
   * 1. Row-level security plus the caller's own scope — a reseller sees only
   *    rows they own, and another brand's uuid does not resolve at all.
   * 2. The purpose gate: a private file the caller did not upload needs the
   *    ability that governs what kind of document it is. A payslip needs
   *    `read Payroll`, so a sales agent holding `read FileObject` still gets
   *    403 (§6, D-115).
   * 3. Only then is the driver asked for a URL, with the configured lifetime.
   *
   * Public objects skip gate 2 by definition: the CDN serves them to anybody.
   */
  async signDownload(
    context: ActiveContext,
    fileId: string,
    scope: SqlLike,
  ): Promise<SignedDownload> {
    const row = await this.load(context, fileId, scope);

    if (row.status !== 'stored') {
      // A pending row is a ticket somebody never used. It is not a file yet,
      // and saying "not found" is the truthful answer as well as the safe one.
      throw new NotFoundException('Not found.');
    }

    this.assertMayRead(context, row);

    try {
      const signed = await this.driver.presignGet({
        key: row.storageKey,
        expiresInSeconds: this.ttlSeconds,
        downloadFilename: row.originalName ?? undefined,
      });
      return { url: signed.url, expiresAt: signed.expiresAt, file: present(row) };
    } catch (error) {
      return mapStorageError(error);
    }
  }

  /** The row, or a 404 that does not say whether it exists in another org. */
  private async load(context: ActiveContext, fileId: string, scope: SqlLike): Promise<FileRow> {
    const row = await findById(
      { orgId: context.orgId, userId: context.userId },
      fileId,
      scope as never,
    );
    if (row === null) throw new NotFoundException('Not found.');
    return row;
  }

  /**
   * Gate 2: may this caller read *this kind of document*?
   *
   * The uploader always may — refusing somebody their own upload would be
   * absurd, and it is also what makes a reseller's KYC scan work without
   * granting them anything org-wide. Everyone else needs the purpose's ability.
   *
   * A purpose with no rule is refused. That direction matters: the opposite
   * default means a document type added by a later milestone is readable by
   * everyone until somebody notices.
   */
  private assertMayRead(context: ActiveContext, row: FileRow): void {
    if (row.visibility === 'public') return;
    if (row.ownerUserId !== null && row.ownerUserId === context.userId) return;

    const rule = PURPOSE_RULES[row.purpose as FilePurpose] as
      (typeof PURPOSE_RULES)[FilePurpose] | undefined;
    if (rule === undefined) {
      throw new ForbiddenException('This file has no download policy, so nobody may read it.');
    }

    const ability = defineAbilityFor({
      roles: context.roles,
      isSuperAdmin: context.isSuperAdmin,
      userId: context.userId,
      branchIds: context.branchIds,
      branchIdsByRole: context.branchIdsByRole,
    });

    if (!ability.can(rule.readRequires.action, rule.readRequires.subject)) {
      // Says what the document is, not what the caller lacks. Listing the
      // missing ability back at them turns a denial into a way of mapping the
      // matrix from outside.
      throw new ForbiddenException(`You cannot read ${row.purpose} files in this organization.`);
    }
  }

  /**
   * Accept the bytes a local signed PUT ticket points at.
   *
   * The local driver's equivalent of uploading straight to R2, and it exists so
   * the two paths are the same shape: the client PUTs to a URL it was given,
   * nothing about the request is trusted except the token, and the server is
   * not a proxy in either case. Without it the local driver would need a
   * different client flow from production, and the flow tests exercise would be
   * the one nobody deploys.
   *
   * Three things are checked, and each is a real refusal rather than a
   * formality: the token's signature and expiry, the content type against the
   * one that was signed, and the size against that type's ceiling. The last is
   * the ceiling neither driver can put on the URL itself, so this is where it
   * has to be.
   */
  async writeSignedContent(token: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const local = this.driver as StorageDriver & {
      verify?: (token: string) => { key: string; method: string; contentType?: string };
    };
    if (typeof local.verify !== 'function') throw new NotFoundException('Not found.');

    try {
      const claims = local.verify(token);
      if (claims.method !== 'PUT') throw new ForbiddenException('This link is not an upload.');

      const declared = (contentType.split(';')[0] ?? '').trim().toLowerCase();
      if (claims.contentType !== undefined && claims.contentType !== declared) {
        throw new BadRequestException(
          `This ticket was issued for ${claims.contentType}, not ${declared}.`,
        );
      }

      const rule = mimeRuleFor(claims.contentType ?? declared);
      assertWithinLimit(bytes.byteLength, rule);

      // Only a pending upload takes bytes. A ticket lives for minutes after the finalize,
      // and a PUT in that window used to replace a stored document's bytes, unaudited,
      // after its hash and sniffed type were recorded (D-389).
      const orgId = claims.key.split('/')[1] ?? '';
      if (!UUID.test(orgId) || (await statusByKey(orgId, claims.key)) !== 'pending') {
        throw new ConflictException('This upload is already stored, or was never started.');
      }

      await this.driver.put(claims.key, bytes, rule.mime);
    } catch (error) {
      mapStorageError(error);
    }
  }

  /**
   * Serve the bytes a local signed URL points at.
   *
   * Only the local driver has this: R2 serves its own signed URLs and the
   * request never reaches us. The token is the entire authorization here — it
   * was issued by `signDownload` after the three gates above — so this method
   * does nothing but verify it and read the key it names.
   */
  async readSignedContent(
    token: string,
  ): Promise<{ bytes: Uint8Array; contentType: string; filename?: string }> {
    const local = this.driver as StorageDriver & {
      verify?: (token: string) => { key: string; method: string; downloadFilename?: string };
    };
    if (typeof local.verify !== 'function') {
      throw new NotFoundException('Not found.');
    }

    try {
      const claims = local.verify(token);
      if (claims.method !== 'GET') throw new ForbiddenException('This link is not a download.');
      const [bytes, head] = await Promise.all([
        this.driver.get(claims.key),
        this.driver.head(claims.key),
      ]);
      return {
        bytes,
        contentType: head?.contentType ?? 'application/octet-stream',
        ...(claims.downloadFilename === undefined ? {} : { filename: claims.downloadFilename }),
      };
    } catch (error) {
      return mapStorageError(error);
    }
  }
}

/**
 * The SQL fragment `scopeWhere` produces.
 *
 * Typed loosely here so the service does not import Drizzle: it never inspects
 * the value, it only hands it to the repository. Narrowing it would mean this
 * module depended on the ORM for a value it treats as opaque.
 */
export type SqlLike = object;
