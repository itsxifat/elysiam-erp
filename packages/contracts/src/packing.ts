import { z } from 'zod';

/**
 * The packing station and the packing video (M38b, D-610 to D-615): the request shapes the
 * server validates at its edge and the console builds.
 */

const uuid = z.string().uuid('No such record.');

/** A code as a scanner typed it: an order number, a courier code, a barcode or a SKU code. */
export const packingCodeSchema = z.string().trim().min(1).max(120);

/** Open the station on an order (or resume it): by a scanned or typed code, or by its id. */
export const packingOpenSchema = z.union([
  z.object({ code: packingCodeSchema }).strict(),
  z.object({ orderId: uuid }).strict(),
]);
export type PackingOpenInput = z.infer<typeof packingOpenSchema>;

/**
 * One scan of a piece. `scanId` is the browser's key for this press of the scanner, so a scan
 * retried after a dropped connection counts once.
 */
export const packingScanSchema = z.object({ scanId: uuid, code: packingCodeSchema }).strict();
export type PackingScanInput = z.infer<typeof packingScanSchema>;

/** Take one piece of a SKU back out of the box. */
export const packingRemovalSchema = z.object({ scanId: uuid, skuId: uuid }).strict();
export type PackingRemovalInput = z.infer<typeof packingRemovalSchema>;

/** What a browser's recorder produces (D-611). */
export const PACKING_VIDEO_MIMES = ['video/webm', 'video/mp4'] as const;
export type PackingVideoMime = (typeof PACKING_VIDEO_MIMES)[number];

/** The longest a part of a packing video may run (D-611): fifteen minutes. */
export const PACKING_VIDEO_MAX_MS = 15 * 60_000;

/** A recording started: its part registered under the browser's own id. */
export const packingVideoStartSchema = z
  .object({
    videoId: uuid,
    startedAt: z.string().datetime({ offset: true }),
    mime: z.enum(PACKING_VIDEO_MIMES),
  })
  .strict();
export type PackingVideoStartInput = z.infer<typeof packingVideoStartSchema>;

/** A recording's finalized upload, attached to its part. */
export const packingVideoFileSchema = z
  .object({
    fileId: uuid,
    // A little over the cap: the recorder stops at fifteen minutes, give or take a frame.
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(PACKING_VIDEO_MAX_MS + 60_000),
  })
  .strict();
export type PackingVideoFileInput = z.infer<typeof packingVideoFileSchema>;

/** The brand's packing settings (D-615). */
export const packingSettingsSchema = z.object({ videoEnabled: z.boolean() }).strict();
export type PackingSettingsInput = z.infer<typeof packingSettingsSchema>;

/** The recent sessions list: newest first, a page at a time. */
export const packingSessionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    status: z.enum(['open', 'completed']).optional(),
  })
  .strict();
export type PackingSessionsQuery = z.infer<typeof packingSessionsQuerySchema>;
