import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { enqueue } from '../../platform/jobs/enqueue.js';
import type { ActiveContext } from '../../platform/http/context.js';
import type { FilePurpose } from './files.policy.js';
import { FILES_QUEUES } from './files.queues.js';
import * as repo from './files.repository.js';
import { FilesService } from './files.service.js';

/** A file as another module checks it before attaching it (M38b). Never its key. */
export interface FileFacts {
  readonly id: string;
  readonly purpose: string;
  readonly status: 'pending' | 'stored';
  readonly visibility: 'private' | 'public';
  readonly ownerUserId: string | null;
  readonly mime: string;
  readonly sizeBytes: number | null;
}

/**
 * What other modules may ask the files module (invariant 12; M35a).
 *
 * A module that stores a file id and later publishes the file has to know the file is one
 * it may publish: stored (the upload finished), public, and uploaded for that purpose. A
 * payslip's id pasted into a flash sale's banner field must not become a public image. The
 * catalog answers this with a join of its own (recorded debt); new callers ask here.
 *
 * M38b adds the packing video's three questions: what a handed file is (before attaching it),
 * a signed download for a row the owning module has checked (D-413), and deleting a file in
 * the caller's transaction with its bytes removed after the commit (D-612).
 */
export interface FilesApi {
  isPublicAsset(tx: Tx, orgId: string, fileId: string, purpose: FilePurpose): Promise<boolean>;

  /** The file's facts, its row locked for the caller's transaction; null when not this brand's. */
  fileFacts(tx: Tx, orgId: string, fileId: string): Promise<FileFacts | null>;

  /**
   * A short-lived URL for a private file of this purpose, for a caller whose access to the
   * thing the file belongs to the owning module has already checked (D-413): the purpose's
   * ability is still required, its reach is not.
   */
  signCheckedDownload(
    context: ActiveContext,
    fileId: string,
    purpose: FilePurpose,
  ): Promise<{ readonly url: string; readonly expiresAt: Date; readonly mime: string }>;

  /**
   * Delete a file of this purpose in the caller's transaction and enqueue the removal of its
   * bytes, which runs only once that transaction commits. False when there was no such file.
   */
  forget(tx: Tx, orgId: string, fileId: string, purpose: FilePurpose): Promise<boolean>;

  /**
   * One page of this brand's files of a purpose created before `before`, oldest first, after
   * the `after` key (M38b audit): the owning module walks them and asks its own tables which
   * are still referenced, so an upload that was finalized and never attached is found and
   * forgotten. Ids and the database's own creation time (the next page's key) only.
   */
  filesOfPurposeBefore(
    tx: Tx,
    orgId: string,
    purpose: FilePurpose,
    before: Date,
    page: {
      readonly after: { readonly createdAt: string; readonly id: string } | null;
      readonly limit: number;
    },
  ): Promise<readonly { readonly id: string; readonly createdAt: string }[]>;
}

export const FILES_API = Symbol('FilesApi');

@Injectable()
export class FilesApiService implements FilesApi {
  constructor(private readonly files: FilesService) {}

  isPublicAsset(tx: Tx, orgId: string, fileId: string, purpose: FilePurpose): Promise<boolean> {
    return repo.publicAssetExists(tx, orgId, fileId, purpose);
  }

  async fileFacts(tx: Tx, orgId: string, fileId: string): Promise<FileFacts | null> {
    const row = await repo.findByIdIn(tx, orgId, fileId);
    if (row === null) return null;
    return {
      id: row.id,
      purpose: row.purpose,
      status: row.status,
      visibility: row.visibility,
      ownerUserId: row.ownerUserId,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
    };
  }

  async signCheckedDownload(context: ActiveContext, fileId: string, purpose: FilePurpose) {
    // The owning module checked the row it belongs to; RLS still bounds the read to the brand.
    const signed = await this.files.signDownload(context, fileId, sql`true`, {
      rowCheckedByOwner: true,
      purpose,
    });
    return { url: signed.url, expiresAt: signed.expiresAt, mime: signed.file.mime };
  }

  async forget(tx: Tx, orgId: string, fileId: string, purpose: FilePurpose): Promise<boolean> {
    const deleted = await repo.deleteIn(tx, orgId, fileId, purpose);
    if (deleted === null) return false;
    await enqueue(
      tx,
      FILES_QUEUES.removeObject.name,
      { keys: deleted.keys },
      { orgId, ref: fileId },
    );
    return true;
  }

  filesOfPurposeBefore(
    tx: Tx,
    orgId: string,
    purpose: FilePurpose,
    before: Date,
    page: {
      readonly after: { readonly createdAt: string; readonly id: string } | null;
      readonly limit: number;
    },
  ): Promise<readonly { readonly id: string; readonly createdAt: string }[]> {
    return repo.purposeFilesBefore(tx, orgId, purpose, before, page);
  }
}
