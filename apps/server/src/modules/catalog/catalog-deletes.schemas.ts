import { z } from 'zod';

/**
 * Edge validation for deleting and archiving catalog rows (M39a).
 *
 * The bodies are small on purpose: a delete names its row in the path and says nothing else,
 * and an archive says at most whether the variants carrying a value go with it.
 */

/** Archive a size or colour, and optionally every active variant that carries it (D-624). */
export const archiveValueSchema = z
  .object({ archiveVariants: z.boolean().default(false) })
  .strict();
export type ArchiveValueInput = z.infer<typeof archiveValueSchema>;

/** A list's values in their new order: every value of the list, once each. */
export const reorderValuesSchema = z
  .object({
    valueIds: z
      .array(z.string().uuid('No such record.'))
      .min(1)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, 'Name each value once.'),
  })
  .strict();
export type ReorderValuesInput = z.infer<typeof reorderValuesSchema>;
