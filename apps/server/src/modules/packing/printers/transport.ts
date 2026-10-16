import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';

/**
 * The wire to a printer (M46, D-810): a raw TCP socket (port 9100) or an IPP POST over HTTP or
 * HTTPS. Only ever called with an address the destination check passed, from a job handler with
 * no transaction open (invariant 6). Behind an interface so the print queue's tests stand a
 * recording printer in its place.
 */
export interface PrinterTransport {
  /** Write the bytes and close; resolves once the printer took them all. */
  sendRaw(host: string, port: number, bytes: Uint8Array, timeoutMs: number): Promise<void>;
  /** Whether the printer accepts a connection on that port. */
  probeRaw(host: string, port: number, timeoutMs: number): Promise<boolean>;
  /** POST an IPP request and read the answer. */
  ipp(
    target: {
      readonly tls: boolean;
      readonly host: string;
      readonly port: number;
      readonly path: string;
    },
    body: Uint8Array,
    auth: { readonly user: string; readonly password: string } | null,
    timeoutMs: number,
  ): Promise<Uint8Array>;
}

export const PRINTER_TRANSPORT = Symbol('PrinterTransport');

/** The largest IPP answer read: attributes, never a document. */
const IPP_ANSWER_MAX = 512 * 1024;

export class PrinterIoError extends Error {
  constructor(
    readonly code: 'unreachable' | 'timeout' | 'refused' | 'protocol',
    message: string,
  ) {
    super(message);
    this.name = 'PrinterIoError';
  }
}

function ioError(error: unknown): PrinterIoError {
  if (error instanceof PrinterIoError) return error;
  const code = (error as { code?: unknown }).code;
  if (code === 'ECONNREFUSED') {
    return new PrinterIoError('refused', 'The printer refused the connection.');
  }
  if (code === 'ETIMEDOUT') return new PrinterIoError('timeout', 'The printer did not answer.');
  return new PrinterIoError('unreachable', 'The printer could not be reached on the network.');
}

export class NetworkPrinterTransport implements PrinterTransport {
  sendRaw(host: string, port: number, bytes: Uint8Array, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error === undefined) resolve();
        else reject(ioError(error));
      };
      socket.setTimeout(timeoutMs, () =>
        finish(new PrinterIoError('timeout', 'The printer stopped taking the job.')),
      );
      socket.once('error', finish);
      socket.once('connect', () => {
        socket.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), () => {
          finish();
        });
      });
    });
  }

  probeRaw(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('error', () => done(false));
      socket.once('connect', () => done(true));
    });
  }

  ipp(
    target: {
      readonly tls: boolean;
      readonly host: string;
      readonly port: number;
      readonly path: string;
    },
    body: Uint8Array,
    auth: { readonly user: string; readonly password: string } | null,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'content-type': 'application/ipp',
        'content-length': String(body.byteLength),
      };
      if (auth !== null) {
        headers.authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`, 'utf8').toString('base64')}`;
      }
      const options = {
        host: target.host,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers,
        timeout: timeoutMs,
      };
      // IPPS (D-814): a printer's certificate is its own, self-signed; on the shop's LAN the
      // connection is encrypted but the printer is known by its address, not a certificate.
      const req = target.tls
        ? httpsRequest({ ...options, rejectUnauthorized: false })
        : httpRequest(options);
      req.once('timeout', () => {
        req.destroy(new PrinterIoError('timeout', 'The printer did not answer.'));
      });
      req.once('error', (error) => reject(ioError(error)));
      req.once('response', (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > IPP_ANSWER_MAX) {
            response.destroy();
            reject(new PrinterIoError('protocol', 'The printer’s answer is too long.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          const status = response.statusCode ?? 0;
          if (status === 401 || status === 403) {
            reject(new PrinterIoError('refused', 'The printer refused the user name or password.'));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new PrinterIoError('protocol', `The printer answered HTTP ${String(status)}.`));
            return;
          }
          resolve(new Uint8Array(Buffer.concat(chunks)));
        });
        response.once('error', (error) => reject(ioError(error)));
      });
      req.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    });
  }
}
