import { Injectable } from '@nestjs/common';
import { serializeFor } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { FilesService } from '../files/files.service.js';
import * as repo from './investors.repository.js';
import { investorsHttpError, mapInvestorErrors } from './investors.errors.js';
import { InvestorsService, investorScope } from './investors.service.js';
import type { AttachDocumentInput } from './investors.schemas.js';

/**
 * Private investor documents, reachable only through a signed URL (§15, §22;
 * check 3).
 *
 * **No row here holds a URL, and no response contains one unless it was just
 * minted for this caller.** A signed URL is a bearer token: once it exists it
 * works for whoever holds it, for as long as it lives. So a list returns file ids,
 * and a URL is issued one request at a time, after the files module has authorized
 * this caller for this document's purpose (D-115).
 *
 * Three checks stand between an upload and a document row, and each has a reason:
 *
 * 1. **stored** — a `pending` row is an upload ticket nobody used. It is not a
 *    file yet, and attaching one would create a document that resolves to nothing.
 * 2. **the `investor-document` purpose** — the purpose is what the files module
 *    authorizes a download against. A KYC scan uploaded as a `product-image` would
 *    be readable by everyone holding `read Catalog`, which is everyone.
 * 3. **private** — the public bucket is served by the CDN with no authorization at
 *    all. An investment agreement carries capital amounts and an NID.
 */

export interface DocumentView {
  readonly id: string;
  readonly investorId: string;
  readonly investmentId: string | null;
  readonly kind: string;
  readonly title: string;
  /** The id only. A URL is minted per request by the files module. */
  readonly fileId: string;
  readonly uploadedAt: string;
}

function view(row: repo.DocumentRow): DocumentView {
  return {
    id: row.id,
    investorId: row.investor_id,
    investmentId: row.investment_id,
    kind: row.kind,
    title: row.title,
    fileId: row.file_id,
    uploadedAt: String(row.created_at),
  };
}

@Injectable()
export class InvestorDocumentsService {
  constructor(
    private readonly files: FilesService,
    private readonly investors: InvestorsService,
    private readonly audit: AuditService,
  ) {}

  async list(
    context: ActiveContext,
    request: object,
    query: { readonly investorId?: string | undefined },
  ): Promise<{ items: readonly DocumentView[] }> {
    const scope = investorScope(request);
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
        serializeFor(context, 'Investor', {
          items: (
            await repo.listDocuments(tx, context.orgId, { scope, investorId: query.investorId })
          ).map(view),
        }),
      ),
    );
  }

  async attach(
    context: ActiveContext,
    request: AuditableRequest,
    input: AttachDocumentInput,
  ): Promise<DocumentView> {
    return mapInvestorErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const investor = await this.investors.requireInvestor(
          tx,
          context,
          request,
          input.investorId,
        );

        if (input.investmentId !== undefined) {
          const investment = await repo.investmentById(tx, context.orgId, input.investmentId);
          if (investment?.investor_id !== investor.id) {
            throw investorsHttpError(
              'INVESTOR_NOT_FOUND',
              'That contribution does not belong to this investor.',
            );
          }
        }

        await this.assertFile(tx, context, input.fileId);

        const id = await repo.insertDocument(tx, {
          orgId: context.orgId,
          investorId: investor.id,
          investmentId: input.investmentId ?? null,
          kind: input.kind,
          title: input.title,
          fileId: input.fileId,
          uploadedBy: context.userId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'investors.document.attached',
          entityType: 'InvestorDocument',
          entityId: id,
          before: null,
          after: {
            investorId: investor.id,
            kind: input.kind,
            title: input.title,
            fileId: input.fileId,
          },
          requestId: context.requestId,
          request,
        });

        const row = await repo.documentById(tx, context.orgId, id);
        if (row === undefined) {
          throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such document.');
        }
        // Through `serializeFor` like every read (invariant 5), although nothing on
        // a document row is a cost field today.
        return serializeFor(context, 'Investor', view(row));
      }),
    );
  }

  /**
   * A short-lived URL for one document, issued only after both gates.
   *
   * Gate one is here: the document is reached through an investor row the caller
   * may see, so `own` scope answers "is this my document" — which is check 1
   * applied to files. Gate two is the files module's own purpose rule, which asks
   * whether this caller may read `investor-document` files at all.
   *
   * **The scope handed to the files module is `true`, deliberately.** Its own scope
   * columns are `owner_user_id`, and an investor's agreement is uploaded by the
   * finance team — so an `own`-scoped caller would be refused their own KYC scan
   * because somebody else uploaded it. The authorization that matters has already
   * happened one line above, against the investor relationship, which is the only
   * thing that makes the document theirs.
   */
  async download(context: ActiveContext, request: object, documentId: string) {
    return mapInvestorErrors(async () => {
      const document = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const row = await repo.documentById(tx, context.orgId, documentId);
          if (row === undefined) {
            throw investorsHttpError('INVESTOR_NOT_FOUND', 'No such document.');
          }
          // Out of scope answers exactly as missing: any other answer tells one
          // investor that another investor's paperwork exists.
          await this.investors.requireInvestor(tx, context, request, row.investor_id);
          return row;
        },
      );

      // The row is checked above, so the files module keeps its purpose gate and drops its
      // brand-wide reach rule, which is for its own generic route (D-413).
      const signed = await this.files.signDownload(context, document.file_id, sql`true`, {
        rowCheckedByOwner: true,
      });
      return serializeFor(context, 'Investor', {
        documentId: document.id,
        title: document.title,
        url: signed.url,
        expiresAt: signed.expiresAt,
      });
    });
  }

  private async assertFile(
    tx: Parameters<typeof repo.documentFile>[0],
    context: ActiveContext,
    fileId: string,
  ): Promise<void> {
    const file = await repo.documentFile(tx, context.orgId, fileId);
    if (file === undefined) {
      throw investorsHttpError('INVESTOR_DOCUMENT_INVALID', 'No such file.');
    }
    if (file.status !== 'stored') {
      throw investorsHttpError(
        'INVESTOR_DOCUMENT_INVALID',
        'That file has not finished uploading.',
      );
    }
    if (file.purpose !== 'investor-document') {
      throw investorsHttpError(
        'INVESTOR_DOCUMENT_INVALID',
        'Upload it with the investor-document purpose, so only the right roles can read it.',
      );
    }
    if (file.visibility !== 'private') {
      throw investorsHttpError(
        'INVESTOR_DOCUMENT_INVALID',
        'An investor document must be a private file (§22).',
      );
    }
  }
}
