import { z } from 'zod';

/**
 * The packing station and the packing video (M38b, D-610 to D-615): the request shapes the
 * server validates at its edge and the console builds.
 */

const uuid = z.string().uuid('No such record.');

/** A code as a scanner typed it: an order number, a courier code, a barcode or a SKU code. */
export const packingCodeSchema = z.string().trim().min(1).max(120);

/**
 * The recording source a packing desk chose (M38c, D-670): one of the brand's IP cameras, or
 * `null` for the desk's own camera recorded by the browser (as M38b). Absent leaves the
 * session's choice as it is.
 */
const cameraChoice = uuid.nullable().optional();

/** Open the station on an order (or resume it): by a scanned or typed code, or by its id. */
export const packingOpenSchema = z.union([
  z.object({ code: packingCodeSchema, cameraId: cameraChoice }).strict(),
  z.object({ orderId: uuid, cameraId: cameraChoice }).strict(),
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

// --- M38c: the packing table's IP cameras (D-668, D-669) ------------------------------------

/** Control characters and whitespace, which no address, user name or password here carries. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Query keys that carry a password: the password goes in its own field, sealed (D-669). */
const SECRET_QUERY_KEY = /^(pass|passwd|password|pwd|pw|secret|token|auth)$/i;

/**
 * A camera's RTSP address, without its credentials (D-668): `rtsp://host[:port]/path`. A user
 * name or password inside the address is refused, because the address is shown and logged
 * where the password must never be; they go in their own fields, the password sealed.
 */
export const rtspUrlSchema = z
  .string()
  .trim()
  .min(1, 'Enter the camera’s RTSP address.')
  .max(500)
  .superRefine((value, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    if (CONTROL.test(value) || /\s/.test(value)) {
      fail('An RTSP address has no spaces.');
      return;
    }
    if (!/^rtsp:\/\//i.test(value)) {
      fail('An RTSP address starts with rtsp://');
      return;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail('That is not an address.');
      return;
    }
    if (url.username !== '' || url.password !== '' || url.host.includes('@')) {
      fail('Put the user name and password in their own fields, not in the address.');
      return;
    }
    if (url.hostname === '') {
      fail('The address names no camera: rtsp://<camera’s address>:554/<stream>');
      return;
    }
    if (url.hash !== '') {
      fail('An RTSP address has no #.');
      return;
    }
    for (const key of url.searchParams.keys()) {
      if (SECRET_QUERY_KEY.test(key)) {
        fail('Put the password in its own field, not in the address.');
        return;
      }
    }
  });

/** The camera's user name for its stream: not secret, but never inside the address. */
export const cameraUsernameSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => !CONTROL.test(value), 'A user name has no control characters.')
  .refine((value) => !value.includes(':'), 'A user name has no colon.');

/** The camera's password: write-only, sealed at rest, never returned (D-669). */
export const cameraPasswordSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !CONTROL.test(value), 'A password has no control characters.');

const cameraNameSchema = z.string().trim().min(1, 'Name the camera.').max(60);

/** A new IP camera for the packing table (`update PackingVideo`, org_admin). */
export const packingCameraCreateSchema = z
  .object({
    name: cameraNameSchema,
    rtspUrl: rtspUrlSchema,
    username: cameraUsernameSchema.default(''),
    password: cameraPasswordSchema.nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PackingCameraCreateInput = z.infer<typeof packingCameraCreateSchema>;

/**
 * A camera changed. `password` absent keeps the one stored, a string replaces it, `null`
 * removes it (a camera whose stream needs none).
 */
export const packingCameraUpdateSchema = z
  .object({
    name: cameraNameSchema,
    rtspUrl: rtspUrlSchema,
    username: cameraUsernameSchema.default(''),
    password: cameraPasswordSchema.nullable().optional(),
    enabled: z.boolean(),
  })
  .strict();
export type PackingCameraUpdateInput = z.infer<typeof packingCameraUpdateSchema>;
