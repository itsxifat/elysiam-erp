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
 * The most cameras a brand records at once (M38c ledger audit, W6): each runs an ffmpeg and a
 * buffer of up to half an hour on the brand server.
 */
export const PACKING_CAMERAS_MAX_ENABLED = 8;

const DOTTED_QUAD = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Why an IPv4 or IPv6 address is not a camera's (M38c ledger audit, W4), or null: loopback,
 * link-local (the cloud metadata address among them), unspecified, multicast and broadcast
 * addresses are the server's own or nobody's. Private LAN ranges stay allowed: the cameras
 * live there.
 */
export function refusedCameraIp(ip: string): string | null {
  const v4 = DOTTED_QUAD.test(ip) ? ip.split('.').map(Number) : null;
  if (v4 !== null) {
    const [a = 0, b = 0] = v4;
    if (a === 127) return 'loopback';
    if (a === 0) return 'unspecified';
    if (a === 169 && b === 254) return 'link-local';
    if (a >= 224) return 'multicast or broadcast';
    return null;
  }
  const hextets = expandIpv6(ip.toLowerCase().replace(/^\[|\]$/g, ''));
  if (hextets === null) return null;
  const [first = 0] = hextets;
  const zeroes = (count: number) => hextets.slice(0, count).every((value) => value === 0);
  if (hextets.every((value) => value === 0)) return 'unspecified';
  if (zeroes(7) && hextets[7] === 1) return 'loopback';
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xff00) === 0xff00) return 'multicast or broadcast';
  // An IPv4 address written as IPv6 (`::ffff:127.0.0.1`): refused outright, written as IPv4.
  if (zeroes(5) && hextets[5] === 0xffff) return 'an IPv4 address in IPv6 form';
  return null;
}

/** An IPv6 address as its eight 16-bit groups, or null when it is not one. */
function expandIpv6(text: string): number[] | null {
  if (!text.includes(':')) return null;
  let body = text;
  // A dotted IPv4 tail (`::ffff:1.2.3.4`) is the last two groups.
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (tail !== null) {
    const quad = tail[2] ?? '';
    if (!DOTTED_QUAD.test(quad)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = quad.split('.').map(Number);
    body = `${tail[1] ?? ''}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const filler = Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0');
  const groups = [...head, ...filler, ...rest];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Why a camera address's host is refused (M38c ledger audit, W4), or null. Besides the
 * addresses `refusedCameraIp` refuses: `localhost`, a one-word name (on the brand server one
 * resolves to the brand's own services: `postgres`, `valkey`, `api`), and a number that is not
 * four plain decimals (`2130706433` and `0x7f.1` are 127.0.0.1 to the resolver).
 */
export function cameraHostRefusal(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name.startsWith('[')) {
    const why = refusedCameraIp(name);
    return why === null ? null : `That address is ${why}, not a camera.`;
  }
  if (name === 'localhost' || name.endsWith('.localhost')) {
    return 'That address is this server itself, not a camera.';
  }
  const labels = name.split('.');
  if (labels.every((label) => /^(0x[0-9a-f]*|[0-9]+)$/.test(label))) {
    if (!DOTTED_QUAD.test(name)) {
      return 'Write the camera’s address as four numbers, like 192.168.20.111.';
    }
    const why = refusedCameraIp(name);
    return why === null ? null : `That address is ${why}, not a camera.`;
  }
  if (labels.length < 2) {
    return 'Use the camera’s IP address or a full host name: a one-word name is one of the server’s own services.';
  }
  return null;
}

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
    const refusal = cameraHostRefusal(url.hostname);
    if (refusal !== null) {
      fail(refusal);
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

/** A camera's name, as the station's list shows it: one per brand. */
export const cameraNameSchema = z.string().trim().min(1, 'Name the camera.').max(60);

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
