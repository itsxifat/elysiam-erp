import { z } from 'zod';

import { packingCodeSchema } from './packing.js';

/**
 * Labels and Packaging (M46, D-800 to D-826): terminals, printers, the print queue and its log,
 * lots, and the handover that needs every lot. The request shapes the server validates at its
 * edge and the console builds.
 */

const uuid = z.string().uuid('No such record.');

// --- terminals (D-801 to D-803) --------------------------------------------------------------

/** A packing desk (scan, pack, film) or a label desk (print). */
export const TERMINAL_KINDS = ['packing', 'label'] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

export const terminalNameSchema = z.string().trim().min(1, 'Name the terminal.').max(40);

export const terminalCreateSchema = z
  .object({
    kind: z.enum(TERMINAL_KINDS),
    name: terminalNameSchema,
    /** The hub's stock location it works for; null serves every location. */
    locationId: uuid.nullable().default(null),
    active: z.boolean().default(true),
  })
  .strict();
export type TerminalCreateInput = z.infer<typeof terminalCreateSchema>;

export const terminalUpdateSchema = z
  .object({
    name: terminalNameSchema,
    locationId: uuid.nullable(),
    active: z.boolean(),
  })
  .strict();
export type TerminalUpdateInput = z.infer<typeof terminalUpdateSchema>;

/** The people who work at a terminal: the whole list, replacing the one before. */
export const terminalMembersSchema = z
  .object({ userIds: z.array(z.string().trim().min(1).max(64)).max(50) })
  .strict();
export type TerminalMembersInput = z.infer<typeof terminalMembersSchema>;

/** A packing terminal's IP cameras: the whole list (D-804). */
export const terminalCamerasSchema = z.object({ cameraIds: z.array(uuid).max(8) }).strict();
export type TerminalCamerasInput = z.infer<typeof terminalCamerasSchema>;

/** "This computer is Packing 2": a supervisor binds the browser it is asked from (D-803). */
export const terminalBindSchema = z
  .object({ label: z.string().trim().min(1, 'Name this computer.').max(60) })
  .strict();
export type TerminalBindInput = z.infer<typeof terminalBindSchema>;

/** The header a bound computer sends its device token in (D-803). */
export const TERMINAL_DEVICE_HEADER = 'x-terminal-device';

// --- printers (D-810 to D-815) ----------------------------------------------------------------

/**
 * How the server reaches a printer: IPP or IPPS (an office or laser printer, sent a PDF), raw
 * TCP 9100 (a thermal label printer, sent its own language), or a browser left open at the
 * label desk (the print station, D-816).
 */
export const PRINTER_CONNECTIONS = ['ipp', 'ipps', 'raw', 'browser'] as const;
export type PrinterConnection = (typeof PRINTER_CONNECTIONS)[number];

/** What a printer is sent: a PDF, or a 1-bit raster in TSPL, ZPL or ESC/POS (D-811). */
export const PRINTER_LANGUAGES = ['pdf', 'tspl', 'zpl', 'escpos'] as const;
export type PrinterLanguage = (typeof PRINTER_LANGUAGES)[number];

/** The paper a printer holds. `custom` takes its own width and height. */
export const PRINTER_MEDIA = ['4x6', '100x150', 'a5', 'a4', 'custom'] as const;
export type PrinterMedium = (typeof PRINTER_MEDIA)[number];

/** Each medium's size in micrometres (exact: 4 in is 101 600 µm). */
export const PRINTER_MEDIUM_UM: Readonly<
  Record<Exclude<PrinterMedium, 'custom'>, { readonly width: number; readonly height: number }>
> = {
  '4x6': { width: 101_600, height: 152_400 },
  '100x150': { width: 100_000, height: 150_000 },
  a5: { width: 148_000, height: 210_000 },
  a4: { width: 210_000, height: 297_000 },
};

export const PRINTER_DPIS = [203, 300] as const;
export type PrinterDpi = (typeof PRINTER_DPIS)[number];

/** What a printer prints: the parcel label and the packing slip. */
export const PRINT_DOCUMENTS = ['label', 'packing_slip'] as const;
export type PrintDocument = (typeof PRINT_DOCUMENTS)[number];

/** Raw printing's ports (D-812): 9100, the JetDirect port, and the nine after it. */
export const RAW_PRINTER_PORTS = { min: 9100, max: 9109 } as const;
/** IPP's own port, and HTTPS and HTTP for the printers that serve IPP there. */
export const IPP_PRINTER_PORTS = [631, 443, 80] as const;

const DOTTED_QUAD = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv4 address as a 32-bit unsigned number, or null when it is not four plain decimals. */
export function ipv4ToNumber(ip: string): number | null {
  if (!DOTTED_QUAD.test(ip)) return null;
  return ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

/** The shop's own network ranges a printer may be on (RFC 1918). */
export const PRIVATE_PRINTER_RANGES = [
  { cidr: '10.0.0.0/8', first: 0x0a000000, last: 0x0affffff },
  { cidr: '172.16.0.0/12', first: 0xac100000, last: 0xac1fffff },
  { cidr: '192.168.0.0/16', first: 0xc0a80000, last: 0xc0a8ffff },
] as const;

/**
 * Why a printer's address is refused (D-812), or null: only an IPv4 address on a private LAN
 * range, never a host name (a name can be pointed anywhere after it is saved), never the
 * network's own or broadcast address. The server's own networks are refused again where the
 * job is sent (the worker knows them; the form does not).
 */
export function printerHostRefusal(host: string): string | null {
  const value = host.trim();
  const number = ipv4ToNumber(value);
  if (number === null) {
    return 'Write the printer’s address as four numbers, like 192.168.20.50. A name is not accepted.';
  }
  const inRange = PRIVATE_PRINTER_RANGES.some(
    (range) => number >= range.first && number <= range.last,
  );
  if (!inRange) {
    return 'Only a printer on the shop’s own network can be used: 10.x.x.x, 172.16.x.x to 172.31.x.x, or 192.168.x.x.';
  }
  const last = number % 256;
  if (last === 0 || last === 255) {
    return 'That is a network’s own address, not a printer’s.';
  }
  return null;
}

/** The printer's user name for IPP's basic sign-in: not secret, never in a log line with the password. */
const printerUsernameSchema = z
  .string()
  .trim()
  .max(64)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f:]/.test(value), 'A user name has no colon.');

/** The printer's password: write-only, sealed at rest, never returned (D-814). */
const printerPasswordSchema = z
  .string()
  .min(1)
  .max(128)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'A password has no control characters.');

const ippPathSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^\/[A-Za-z0-9._~\-/]*$/, 'The IPP path starts with / (for example /ipp/print).');

const printerFields = {
  terminalId: uuid,
  name: z.string().trim().min(1, 'Name the printer.').max(60),
  connection: z.enum(PRINTER_CONNECTIONS),
  language: z.enum(PRINTER_LANGUAGES),
  host: z.string().trim().max(64).nullable().default(null),
  port: z.number().int().min(1).max(65_535).nullable().default(null),
  ippPath: ippPathSchema.default('/ipp/print'),
  dpi: z.union([z.literal(203), z.literal(300)]).default(203),
  medium: z.enum(PRINTER_MEDIA),
  /** Only for `custom`: millimetres, 20 to 330. */
  widthMm: z.number().min(20).max(330).nullable().default(null),
  heightMm: z.number().min(20).max(1000).nullable().default(null),
  documents: z.array(z.enum(PRINT_DOCUMENTS)).min(1, 'Choose what it prints.').max(2),
  copies: z.number().int().min(1).max(5).default(1),
  username: printerUsernameSchema.default(''),
  enabled: z.boolean().default(true),
};

interface PrinterShape {
  connection: PrinterConnection;
  language: PrinterLanguage;
  host: string | null;
  port: number | null;
  medium: PrinterMedium;
  widthMm: number | null;
  heightMm: number | null;
  username: string;
  password?: string | null | undefined;
}

/** The rules between a printer's fields: what each connection sends, where, and its paper. */
function checkPrinter(value: PrinterShape, context: z.RefinementCtx): void {
  const fail = (path: string, message: string) =>
    context.addIssue({ code: 'custom', path: [path], message });
  if (value.connection === 'browser') {
    if (value.host !== null || value.port !== null) {
      fail('host', 'A browser print station has no address: it prints from the label desk.');
    }
    if (value.language !== 'pdf') fail('language', 'A browser print station prints PDFs.');
  } else {
    if (value.host === null || value.host === '') {
      fail('host', 'Enter the printer’s address on the shop’s network.');
    } else {
      const refusal = printerHostRefusal(value.host);
      if (refusal !== null) fail('host', refusal);
    }
    if (value.connection === 'raw') {
      if (value.language === 'pdf') {
        fail('language', 'A label printer on port 9100 speaks TSPL, ZPL or ESC/POS.');
      }
      const port = value.port ?? RAW_PRINTER_PORTS.min;
      if (port < RAW_PRINTER_PORTS.min || port > RAW_PRINTER_PORTS.max) {
        fail('port', 'Raw printing uses port 9100 (or 9101 to 9109).');
      }
    } else {
      if (value.language !== 'pdf') fail('language', 'An IPP printer is sent PDFs.');
      const port = value.port ?? 631;
      if (!(IPP_PRINTER_PORTS as readonly number[]).includes(port)) {
        fail('port', 'IPP uses port 631 (or 443 or 80 on some printers).');
      }
    }
  }
  if (value.medium === 'custom') {
    if (value.widthMm === null || value.heightMm === null) {
      fail('widthMm', 'Enter the paper’s width and height in millimetres.');
    }
  }
  if (typeof value.password === 'string' && value.connection !== 'ipps') {
    // A password over plain IPP or a raw socket would cross the network in clear (D-814).
    fail('password', 'A printer password is sent only over IPPS.');
  }
  if (value.username !== '' && value.connection !== 'ipps' && value.connection !== 'ipp') {
    fail('username', 'Only an IPP printer takes a user name.');
  }
}

export const printerCreateSchema = z
  .object({ ...printerFields, password: printerPasswordSchema.nullable().optional() })
  .strict()
  .superRefine(checkPrinter);
export type PrinterCreateInput = z.infer<typeof printerCreateSchema>;

/** A printer changed. `password` absent keeps the stored one, a string replaces it, null removes it. */
export const printerUpdateSchema = z
  .object({
    ...printerFields,
    enabled: z.boolean(),
    password: printerPasswordSchema.nullable().optional(),
  })
  .strict()
  .superRefine(checkPrinter);
export type PrinterUpdateInput = z.infer<typeof printerUpdateSchema>;

// --- the print queue and its log (D-813, D-817, D-818) --------------------------------------

export const PRINT_JOB_STATES = ['queued', 'sending', 'printed', 'failed', 'cancelled'] as const;
export type PrintJobStateName = (typeof PRINT_JOB_STATES)[number];

export const PRINT_SOURCES = ['auto', 'manual', 'reprint', 'test'] as const;
export type PrintSource = (typeof PRINT_SOURCES)[number];

/** A reprint's reason (D-818): a few words a supervisor reads later. */
export const reprintReasonSchema = z
  .string()
  .trim()
  .min(3, 'Say why it is printed again.')
  .max(200);

/**
 * Print these orders' documents now (Labels → Ready for label, the bulk print, a reprint).
 * `lots` absent prints every lot; a document already printed for that order and lot is a
 * reprint and needs `reason`.
 */
export const printRequestSchema = z
  .object({
    orderIds: z.array(uuid).min(1).max(100),
    documents: z.array(z.enum(PRINT_DOCUMENTS)).min(1).max(2),
    lots: z.array(z.number().int().min(1).max(20)).min(1).max(20).optional(),
    /** One printer, or a terminal (its printer for each document), or neither (the order's). */
    printerId: uuid.optional(),
    terminalId: uuid.optional(),
    reason: reprintReasonSchema.optional(),
    copies: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type PrintRequestInput = z.infer<typeof printRequestSchema>;

export const printJobsQuerySchema = z
  .object({
    state: z.enum(PRINT_JOB_STATES).optional(),
    /** `open`: queued or sending, the queue; absent: the whole log. */
    view: z.enum(['queue', 'log']).default('log'),
    source: z.enum(PRINT_SOURCES).optional(),
    orderId: uuid.optional(),
    terminalId: uuid.optional(),
    printerId: uuid.optional(),
    /** An order number, or part of one. */
    q: z.string().trim().min(2).max(64).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
export type PrintJobsQuery = z.infer<typeof printJobsQuerySchema>;

export const readyForLabelQuerySchema = z
  .object({
    locationId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type ReadyForLabelQuery = z.infer<typeof readyForLabelQuerySchema>;

/** The brand's auto-print rule (D-817). */
export const labelSettingsSchema = z
  .object({
    /** Print each lot's parcel label the moment the order has its consignment. */
    autoPrint: z.boolean(),
    /** And its packing slip with it. */
    autoSlip: z.boolean(),
  })
  .strict();
export type LabelSettingsInput = z.infer<typeof labelSettingsSchema>;

/** The browser print station's word on one job (D-816). */
export const stationResultSchema = z
  .object({
    result: z.enum(['printed', 'failed']),
    error: z.string().trim().max(300).optional(),
  })
  .strict();
export type StationResultInput = z.infer<typeof stationResultSchema>;

// --- lots and the handover (D-805 to D-808) ---------------------------------------------------

/** How many bags an order goes in: set by the label printer or the packer, 1 to 20. */
export const lotCountSchema = z.object({ count: z.number().int().min(1).max(20) }).strict();
export type LotCountInput = z.infer<typeof lotCountSchema>;

/** One label scanned at the courier's handover: an order number, a lot code, a consignment. */
export const handoverScanSchema = z.object({ code: packingCodeSchema }).strict();
export type HandoverScanInput = z.infer<typeof handoverScanSchema>;

/** Hand these orders to the courier: each only if every lot's label was scanned. */
export const handoverShipSchema = z.object({ orderIds: z.array(uuid).min(1).max(200) }).strict();
export type HandoverShipInput = z.infer<typeof handoverShipSchema>;
