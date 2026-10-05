import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import type { FilePurpose } from './files.policy.js';
import * as repo from './files.repository.js';

/**
 * What other modules may ask the files module (invariant 12; M35a).
 *
 * A module that stores a file id and later publishes the file has to know the file is one
 * it may publish: stored (the upload finished), public, and uploaded for that purpose. A
 * payslip's id pasted into a flash sale's banner field must not become a public image. The
 * catalog answers this with a join of its own (recorded debt); new callers ask here.
 */
export interface FilesApi {
  isPublicAsset(tx: Tx, orgId: string, fileId: string, purpose: FilePurpose): Promise<boolean>;
}

export const FILES_API = Symbol('FilesApi');

@Injectable()
export class FilesApiService implements FilesApi {
  isPublicAsset(tx: Tx, orgId: string, fileId: string, purpose: FilePurpose): Promise<boolean> {
    return repo.publicAssetExists(tx, orgId, fileId, purpose);
  }
}
