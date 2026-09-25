import { z } from 'zod';

import { filePurposeSchema } from './files.policy.js';

/**
 * The file endpoints' request shapes.
 *
 * These belong in `packages/contracts` by convention (CLAUDE.md: "validate at
 * the edge with the shared Zod schemas"), and M04's API-layer slice is what
 * generates OpenAPI from that package. They are here for now because moving
 * them is a one-line re-export once the contracts surface for M04 settles, and
 * a half-written schema in a shared package is worse than a complete one in a
 * module. Logged as a follow-up.
 */

export const uploadTicketSchema = z.object({
  purpose: filePurposeSchema,
  /**
   * What the client says it is about to send.
   *
   * Checked against the allow-list now, and checked *again* against the bytes'
   * magic number when they arrive. This one only decides whether a ticket is
   * issued at all; it is not evidence about anything.
   */
  contentType: z.string().min(1).max(255),
  /**
   * The name on the uploader's machine, for display.
   *
   * Never a storage key, so the only thing it can break is a heading. Bounded
   * anyway, and the control characters are stripped: a filename is
   * attacker-controlled text that ends up in a PDF, a log line and a
   * `Content-Disposition` header.
   */
  originalName: z
    .string()
    .max(255)
    // Stripping control characters is the entire purpose here. A filename with
    // a newline or a NUL in it ends up in a `Content-Disposition` header and in
    // log lines; the lint rule exists to catch such characters being matched by
    // accident, which is the opposite of what this is.
    // eslint-disable-next-line no-control-regex
    .transform((value) => value.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim())
    .optional(),
  /**
   * Defaults to private, and the default is the point (§22). A field that
   * decides who may read a document must not be satisfiable by omission.
   */
  visibility: z.enum(['private', 'public']).default('private'),
  /** Declared so the server can refuse before the client spends the upload. */
  sizeBytes: z.coerce.number().int().positive().max(104_857_600),
});

export type UploadTicketInput = z.infer<typeof uploadTicketSchema>;

export const fileIdSchema = z.string().uuid();
