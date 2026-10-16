import { createServer, type AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';

import { printerHostRefusal } from '@elysium/contracts';
import { describe, expect, it } from 'vitest';

import { destinationRefusal, ownNetworks, parseCidr } from './destination.js';
import {
  IPP_GET_PRINTER_ATTRIBUTES,
  IPP_PRINT_JOB,
  ippGetPrinterAttributes,
  ippPrintJob,
  ippPrinterState,
  ippSucceeded,
  parseIppResponse,
} from './ipp.js';
import { ESCPOS_BAND_ROWS, escposJob, tsplJob, zplJob } from './languages.js';
import { decodePng, encodePng, type DecodedImage } from './png.js';
import { dotsFor, toMonochrome, type MonoBitmap } from './raster.js';
import { fitScale } from './render.js';
import { NetworkPrinterTransport } from './transport.js';

/**
 * M46's printer drivers, byte for byte (D-810 to D-812): the PNG reader the raster path stands
 * on, the threshold to one bit a dot, TSPL's, ZPL's and ESC/POS's framing of the page, IPP's
 * Print-Job and Get-Printer-Attributes and the reading of a printer's answer, the private-LAN
 * rule with the server's own networks, and a raw socket that delivers every byte.
 */

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): DecodedImage {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[y * width + x] = pixel(x, y);
  }
  return { width, height, channels: 1, data };
}

/** A PNG whose every row uses the given filter (what Chromium writes), built by hand. */
function filteredPng(source: DecodedImage, filter: 0 | 1 | 2 | 3 | 4): Uint8Array {
  const { width, height, channels, data } = source;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const value = data[y * stride + x] ?? 0;
      const a = x >= channels ? (data[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (data[(y - 1) * stride + x - channels] ?? 0) : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      if (filter === 2) predicted = b;
      if (filter === 3) predicted = (a + b) >> 1;
      if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + x] = (value - predicted) & 0xff;
    }
  }
  // Reuse the encoder's framing, swapping in the filtered IDAT.
  const plain = Buffer.from(encodePng(source));
  const idatAt = plain.indexOf('IDAT', 0, 'latin1') - 4;
  const head = plain.subarray(0, idatAt);
  const body = deflateSync(raw);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const crcTable = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return out;
  };
  const typed = Buffer.concat([Buffer.from('IDAT', 'latin1'), body]);
  const end = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return new Uint8Array(Buffer.concat([head, length, typed, crcTable(typed), end]));
}

describe('the PNG reader (D-811)', () => {
  const source = image(17, 9, (x, y) => (x * 37 + y * 11) % 256);

  it('reads back what was written, through every row filter', () => {
    for (const filter of [0, 1, 2, 3, 4] as const) {
      const decoded = decodePng(filteredPng(source, filter));
      expect(decoded.width).toBe(17);
      expect(decoded.height).toBe(9);
      expect(Buffer.from(decoded.data).equals(Buffer.from(source.data))).toBe(true);
    }
  });

  it('reads RGBA as Chromium writes it, and refuses what it does not read', () => {
    const rgba: DecodedImage = {
      width: 2,
      height: 1,
      channels: 4,
      data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]),
    };
    expect(decodePng(encodePng(rgba))).toMatchObject({ width: 2, height: 1, channels: 4 });
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/Not a PNG/);
  });
});

describe('the raster (D-811)', () => {
  it('prints dark dots, leaves light and transparent ones, and pads to whole bytes', () => {
    // A 10 × 2 picture: the first row black then white, the second white then black.
    const picture = image(10, 2, (x, y) => (y === 0 ? (x < 5 ? 0 : 255) : x < 5 ? 255 : 10));
    const bitmap = toMonochrome(picture, { widthDots: 10, heightDots: 3 });
    expect(bitmap.widthBytes).toBe(2);
    expect(bitmap.widthDots).toBe(16);
    expect([...bitmap.rows]).toEqual([0xf8, 0x00, 0x07, 0xc0, 0x00, 0x00]);
    const clear: DecodedImage = {
      width: 1,
      height: 1,
      channels: 4,
      data: new Uint8Array([0, 0, 0, 0]),
    };
    expect([...toMonochrome(clear, { widthDots: 8, heightDots: 1 }).rows]).toEqual([0x00]);
  });

  it('counts a printer’s dots: 4 × 6 in is 812 × 1218 at 203 dpi, 100 mm is 1181 at 300', () => {
    expect(dotsFor(101_600, 203)).toBe(812);
    expect(dotsFor(152_400, 203)).toBe(1218);
    expect(dotsFor(100_000, 300)).toBe(1181);
  });

  it('shrinks a page to fit smaller paper, never enlarges it', () => {
    const page = { html: '', assets: [], widthMm: 101.6, heightMm: 152.4, marginMm: 0 };
    const paper = { language: 'pdf' as const, dpi: 203, copies: 1 };
    expect(fitScale(page, { ...paper, widthUm: 101_600, heightUm: 152_400 })).toBe(1);
    expect(fitScale(page, { ...paper, widthUm: 210_000, heightUm: 297_000 })).toBe(1);
    expect(fitScale(page, { ...paper, widthUm: 100_000, heightUm: 150_000 })).toBeCloseTo(
      0.9843,
      3,
    );
  });
});

const bitmap: MonoBitmap = {
  widthDots: 16,
  widthBytes: 2,
  heightDots: 3,
  rows: new Uint8Array([0xff, 0x00, 0x81, 0x18, 0x00, 0xff]),
};

describe('TSPL, ZPL and ESC/POS (D-810)', () => {
  it('frames TSPL: size, gap, one bitmap with 0 for a printed dot, then PRINT', () => {
    const bytes = Buffer.from(tsplJob(bitmap, { widthUm: 101_600, heightUm: 152_400, copies: 2 }));
    const head =
      'SIZE 101.6 mm,152.4 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\nBITMAP 0,0,2,3,0,';
    expect(bytes.subarray(0, head.length).toString('latin1')).toBe(head);
    expect([...bytes.subarray(head.length, head.length + 6)]).toEqual([
      0x00, 0xff, 0x7e, 0xe7, 0xff, 0x00,
    ]);
    expect(bytes.subarray(head.length + 6).toString('latin1')).toBe('\r\nPRINT 1,2\r\n');
  });

  it('frames ZPL: width, length, the page as ^GFA hex with 1 for black, copies', () => {
    const text = Buffer.from(zplJob(bitmap, { copies: 3 })).toString('latin1');
    expect(text).toBe(
      '^XA\n^PW16\n^LL3\n^LH0,0\n^FO0,0^GFA,6,6,2,FF008118' + '00FF^FS\n^PQ3\n^XZ\n',
    );
  });

  it('frames ESC/POS: GS v 0 in bands of at most 255 rows, then a feed and a cut, per copy', () => {
    const tall: MonoBitmap = {
      widthDots: 8,
      widthBytes: 1,
      heightDots: 300,
      rows: new Uint8Array(300).fill(0xaa),
    };
    const bytes = Buffer.from(escposJob(tall, { copies: 1 }));
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.subarray(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, ESCPOS_BAND_ROWS, 0]);
    const second = 10 + ESCPOS_BAND_ROWS;
    expect([...bytes.subarray(second, second + 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 1, 0, 45, 0]);
    expect([...bytes.subarray(bytes.length - 7)]).toEqual([
      0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00,
    ]);
    expect(bytes.length).toBe(2 + 8 + 255 + 8 + 45 + 7);
    expect(Buffer.from(escposJob(tall, { copies: 2 })).length).toBe(bytes.length * 2);
  });
});

describe('IPP (D-810, D-815)', () => {
  const target = { printerUri: 'ipp://192.168.20.50:631/ipp/print', user: 'erp' };

  it('writes a Print-Job: IPP/1.1, the operation attributes, copies, the end, then the PDF', () => {
    const pdf = Buffer.from('%PDF-1.7 test');
    const bytes = Buffer.from(
      ippPrintJob({ ...target, jobName: 'ELY-2610-00042 label 1/3', copies: 2 }, pdf, 7),
    );
    expect([...bytes.subarray(0, 8)]).toEqual([1, 1, 0, IPP_PRINT_JOB, 0, 0, 0, 7]);
    expect(bytes.subarray(bytes.length - pdf.length).equals(pdf)).toBe(true);
    const read = parseIppResponse(bytes.subarray(0, bytes.length - pdf.length));
    expect(read.attributes.get('attributes-charset')).toEqual(['utf-8']);
    expect(read.attributes.get('printer-uri')).toEqual([target.printerUri]);
    expect(read.attributes.get('document-format')).toEqual(['application/pdf']);
    expect(read.attributes.get('job-name')).toEqual(['ELY-2610-00042 label 1/3']);
    expect(read.attributes.get('copies')).toEqual([2]);
  });

  it('asks a printer for its state, reasons, model and formats in one attribute', () => {
    const read = parseIppResponse(ippGetPrinterAttributes(target, 3));
    expect(read.statusCode).toBe(IPP_GET_PRINTER_ATTRIBUTES);
    expect(read.attributes.get('requested-attributes')).toEqual([
      'printer-state',
      'printer-state-reasons',
      'printer-make-and-model',
      'document-format-supported',
    ]);
  });

  /** A printer's answer, written the way a printer writes one. */
  function answer(status: number, state: number, reasons: string[]): Uint8Array {
    const attr = (tag: number, name: string, value: Buffer) => {
      const head = Buffer.alloc(3 + name.length + 2);
      head[0] = tag;
      head.writeUInt16BE(name.length, 1);
      head.write(name, 3, 'latin1');
      head.writeUInt16BE(value.length, 3 + name.length);
      return Buffer.concat([head, value]);
    };
    const int = Buffer.alloc(4);
    int.writeInt32BE(state, 0);
    const head = Buffer.from([1, 1, status >> 8, status & 0xff, 0, 0, 0, 3]);
    return new Uint8Array(
      Buffer.concat([
        head,
        Buffer.from([0x01]),
        attr(0x47, 'attributes-charset', Buffer.from('utf-8')),
        Buffer.from([0x04]),
        attr(0x23, 'printer-state', int),
        ...reasons.map((reason, index) =>
          attr(0x44, index === 0 ? 'printer-state-reasons' : '', Buffer.from(reason)),
        ),
        Buffer.from([0x03]),
      ]),
    );
  }

  it('reads a printer idle with a warning as online, a stopped one as an error', () => {
    const idle = parseIppResponse(answer(0x0000, 3, ['none']));
    expect(ippSucceeded(idle.statusCode)).toBe(true);
    expect(ippPrinterState(idle)).toEqual({ state: 'online', detail: null });
    const warned = parseIppResponse(answer(0x0000, 4, ['toner-low-warning']));
    expect(ippPrinterState(warned)).toEqual({ state: 'online', detail: 'toner-low-warning' });
    const stopped = parseIppResponse(answer(0x0000, 5, ['media-empty-error', 'cover-open']));
    expect(ippPrinterState(stopped)).toEqual({
      state: 'error',
      detail: 'media-empty-error, cover-open',
    });
    expect(ippSucceeded(parseIppResponse(answer(0x0400, 3, [])).statusCode)).toBe(false);
  });
});

describe('where a print may go (D-812)', () => {
  it('takes an IPv4 address on a private LAN range, nothing else', () => {
    expect(printerHostRefusal('192.168.20.50')).toBeNull();
    expect(printerHostRefusal('10.1.2.3')).toBeNull();
    expect(printerHostRefusal('172.20.0.9')).toBeNull();
    for (const host of [
      '8.8.8.8',
      '127.0.0.1',
      '169.254.169.254',
      '172.32.0.1',
      '192.168.20.0',
      '192.168.20.255',
      'printer.local',
      'localhost',
      '0x7f.1',
      '',
    ]) {
      expect(printerHostRefusal(host), host).not.toBeNull();
    }
  });

  it('refuses the server’s own networks: a container’s every network, a host’s bridges only', () => {
    const interfaces = {
      eth0: [
        {
          address: '172.18.0.5',
          netmask: '255.255.0.0',
          family: 'IPv4' as const,
          mac: '',
          internal: false,
          cidr: null,
        },
      ],
      'Ethernet 2': [
        {
          address: '192.168.20.7',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '',
          internal: false,
          cidr: null,
        },
      ],
      'br-1a2b3c': [
        {
          address: '172.19.0.1',
          netmask: '255.255.0.0',
          family: 'IPv4' as const,
          mac: '',
          internal: false,
          cidr: null,
        },
      ],
    };
    const container = ownNetworks({ interfaces, inContainer: true, refused: '' });
    expect(destinationRefusal('172.18.0.2', container)).toMatch(/server’s own network/);
    expect(destinationRefusal('192.168.20.50', container)).toMatch(/server’s own network/);
    const host = ownNetworks({ interfaces, inContainer: false, refused: '172.17.0.0/16' });
    expect(destinationRefusal('192.168.20.50', host)).toBeNull();
    expect(destinationRefusal('172.19.0.3', host)).toMatch(/server’s own network/);
    expect(destinationRefusal('172.17.0.1', host)).toMatch(/server’s own network/);
    expect(destinationRefusal('8.8.8.8', host)).toMatch(/shop’s own network/);
    expect(parseCidr('10.0.0.0/8')).toMatchObject({ first: 0x0a000000, last: 0x0affffff });
    expect(parseCidr('nonsense')).toBeNull();
  });
});

describe('the raw socket (D-810)', () => {
  it('delivers every byte and closes; an unreachable printer is an error, not a hang', async () => {
    const received: Buffer[] = [];
    const server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => received.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const transport = new NetworkPrinterTransport();
    const job = Buffer.alloc(200_000, 0x5a);
    await transport.sendRaw('127.0.0.1', port, job, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Buffer.concat(received).equals(job)).toBe(true);
    expect(await transport.probeRaw('127.0.0.1', port, 1_000)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(transport.sendRaw('127.0.0.1', port, job, 1_000)).rejects.toMatchObject({
      code: 'refused',
    });
    expect(await transport.probeRaw('127.0.0.1', port, 500)).toBe(false);
  });
});
