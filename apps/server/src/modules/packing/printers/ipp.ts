/**
 * IPP, as much of it as printing a PDF and asking a printer how it is needs (M46, D-810,
 * D-815): RFC 8010's encoding and RFC 8011's Print-Job (0x0002) and Get-Printer-Attributes
 * (0x000B), over HTTP POST with `Content-Type: application/ipp`. IPP/1.1, which every IPP
 * printer accepts (IPP Everywhere printers take 2.0 too, and answer 1.1).
 *
 * A request is the version, the operation, a request id, the operation attributes group
 * (charset, natural language, printer URI, requesting user, and for a print the job name and
 * the document's format), for a print the job attributes group (copies), the end tag, then the
 * document. The answer's status code is below 0x0100 when it worked.
 */

export const IPP_PRINT_JOB = 0x0002;
export const IPP_GET_PRINTER_ATTRIBUTES = 0x000b;

/** RFC 8010 §3.5.1 delimiter tags and §3.5.2 value tags. */
const TAG = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  text: 0x41,
  name: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  language: 0x48,
  mimeType: 0x49,
} as const;

function attribute(tag: number, name: string, value: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(3 + nameBytes.length + 2);
  head[0] = tag;
  head.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(head, 3);
  head.writeUInt16BE(value.length, 3 + nameBytes.length);
  return Buffer.concat([head, value]);
}

const text = (value: string) => Buffer.from(value, 'utf8');

function integer(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value, 0);
  return bytes;
}

export interface IppTarget {
  /** `ipp://192.168.20.50:631/ipp/print`: the printer-uri attribute. */
  readonly printerUri: string;
  readonly user: string;
}

function header(operation: number, requestId: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes[0] = 1;
  bytes[1] = 1;
  bytes.writeUInt16BE(operation, 2);
  bytes.writeUInt32BE(requestId >>> 0, 4);
  return bytes;
}

function operationGroup(target: IppTarget): Buffer[] {
  return [
    Buffer.from([TAG.operation]),
    attribute(TAG.charset, 'attributes-charset', text('utf-8')),
    attribute(TAG.language, 'attributes-natural-language', text('en')),
    attribute(TAG.uri, 'printer-uri', text(target.printerUri)),
    attribute(TAG.name, 'requesting-user-name', text(target.user.slice(0, 60) || 'erp')),
  ];
}

/** A Print-Job request carrying a PDF. */
export function ippPrintJob(
  target: IppTarget & { readonly jobName: string; readonly copies: number },
  document: Uint8Array,
  requestId = 1,
): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      header(IPP_PRINT_JOB, requestId),
      ...operationGroup(target),
      attribute(TAG.name, 'job-name', text(target.jobName.slice(0, 120))),
      attribute(TAG.mimeType, 'document-format', text('application/pdf')),
      Buffer.from([TAG.job]),
      attribute(TAG.integer, 'copies', integer(target.copies)),
      Buffer.from([TAG.end]),
      Buffer.from(document.buffer, document.byteOffset, document.byteLength),
    ]),
  );
}

/** What a status probe asks for. */
export const PROBED_ATTRIBUTES = [
  'printer-state',
  'printer-state-reasons',
  'printer-make-and-model',
  'document-format-supported',
] as const;

/** A Get-Printer-Attributes request for the state, its reasons, the model and the formats. */
export function ippGetPrinterAttributes(target: IppTarget, requestId = 1): Uint8Array {
  const [first, ...rest] = PROBED_ATTRIBUTES;
  return new Uint8Array(
    Buffer.concat([
      header(IPP_GET_PRINTER_ATTRIBUTES, requestId),
      ...operationGroup(target),
      attribute(TAG.keyword, 'requested-attributes', text(first)),
      // Further values of the same attribute have an empty name (RFC 8010 §3.1.5).
      ...rest.map((name) => attribute(TAG.keyword, '', text(name))),
      Buffer.from([TAG.end]),
    ]),
  );
}

export type IppValue = string | number | boolean;

export interface IppResponse {
  readonly statusCode: number;
  readonly requestId: number;
  /** Every attribute of every group, by name; a multi-valued one has several values. */
  readonly attributes: ReadonlyMap<string, readonly IppValue[]>;
}

export class IppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IppError';
  }
}

/** Read an IPP response (any group, any attribute; strings, integers, enums and booleans). */
export function parseIppResponse(bytes: Uint8Array): IppResponse {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 9) throw new IppError('The printer’s IPP answer is too short.');
  const statusCode = buffer.readUInt16BE(2);
  const requestId = buffer.readUInt32BE(4);
  const attributes = new Map<string, IppValue[]>();
  let offset = 8;
  let last = '';
  while (offset < buffer.length) {
    const tag = buffer[offset] ?? TAG.end;
    offset += 1;
    if (tag === TAG.end) break;
    if (tag < 0x10) continue; // the next attribute group
    if (offset + 2 > buffer.length) throw new IppError('The printer’s IPP answer is cut short.');
    const nameLength = buffer.readUInt16BE(offset);
    offset += 2;
    const name = buffer.toString('utf8', offset, offset + nameLength);
    offset += nameLength;
    if (offset + 2 > buffer.length) throw new IppError('The printer’s IPP answer is cut short.');
    const valueLength = buffer.readUInt16BE(offset);
    offset += 2;
    if (offset + valueLength > buffer.length) {
      throw new IppError('The printer’s IPP answer is cut short.');
    }
    const raw = buffer.subarray(offset, offset + valueLength);
    offset += valueLength;
    let value: IppValue;
    if ((tag === TAG.integer || tag === TAG.enum) && raw.length === 4) value = raw.readInt32BE(0);
    else if (tag === TAG.boolean && raw.length === 1) value = raw[0] === 1;
    else value = raw.toString('utf8');
    const key = name === '' ? last : name;
    if (name !== '') last = name;
    const values = attributes.get(key) ?? [];
    values.push(value);
    attributes.set(key, values);
  }
  return { statusCode, requestId, attributes };
}

/** Whether an IPP status code means it worked (`successful-ok` and its kin, below 0x0100). */
export function ippSucceeded(statusCode: number): boolean {
  return statusCode < 0x0100;
}

/** RFC 8011 §5.4.11: 3 idle, 4 processing, 5 stopped. */
export function ippPrinterState(response: IppResponse): {
  readonly state: 'online' | 'error';
  readonly detail: string | null;
} {
  const state = response.attributes.get('printer-state')?.[0];
  const reasons = (response.attributes.get('printer-state-reasons') ?? [])
    .map(String)
    .filter((reason) => reason !== 'none');
  const detail = reasons.length === 0 ? null : reasons.join(', ').slice(0, 200);
  if (state === 5) return { state: 'error', detail: detail ?? 'stopped' };
  // A printer that is idle or printing is online even with a warning such as toner-low.
  return { state: 'online', detail };
}
