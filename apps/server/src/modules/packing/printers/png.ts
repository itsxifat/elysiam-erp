import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A PNG reader small enough to read in one sitting (M46, D-811): what Chromium's screenshot
 * gives us, and nothing else. Eight bits per channel, not interlaced, grey, grey with alpha,
 * RGB or RGBA; anything else is refused rather than guessed at. Node's own zlib inflates; no
 * dependency (an image library would bring a native build into the server image for a
 * threshold we can write in ten lines).
 *
 * The encoder beside it is for the tests and the test page's fixtures: grey or RGBA, filter 0.
 */

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** 1 (grey), 2 (grey + alpha), 3 (RGB) or 4 (RGBA) bytes per pixel. */
  readonly channels: 1 | 2 | 3 | 4;
  readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The most pixels a label or slip at 300 dpi can need (A4 is 2481 × 3508). */
const MAX_PIXELS = 4000 * 4000;

const CHANNELS: Readonly<Record<number, 1 | 2 | 3 | 4>> = { 0: 1, 4: 2, 2: 3, 6: 4 };

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('Not a PNG.');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 1 | 2 | 3 | 4 | undefined;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) throw new PngError('A PNG chunk runs past the end.');
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      const depth = buffer[start + 8];
      const colour = buffer[start + 9] ?? -1;
      const interlace = buffer[start + 12];
      if (depth !== 8) throw new PngError('Only 8-bit PNGs are read.');
      if (interlace !== 0) throw new PngError('Interlaced PNGs are not read.');
      channels = CHANNELS[colour];
      if (channels === undefined) throw new PngError('That PNG colour type is not read.');
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) {
        throw new PngError('That PNG is too large.');
      }
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (channels === undefined) throw new PngError('A PNG without its header.');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new PngError('A PNG shorter than its size.');
  const out = new Uint8Array(stride * height);
  const bpp = channels;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    const above = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[line + x] ?? 0;
      const a = x >= bpp ? (out[row + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[above + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[above + x - bpp] ?? 0) : 0;
      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = a;
          break;
        case 2:
          predicted = b;
          break;
        case 3:
          predicted = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new PngError('A PNG row has an unknown filter.');
      }
      out[row + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** CRC-32 of a chunk's type and data (the PNG's own polynomial). */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of these pixels (grey or RGBA), every row unfiltered. */
export function encodePng(image: DecodedImage): Uint8Array {
  const colour = image.channels === 1 ? 0 : image.channels === 2 ? 4 : image.channels === 3 ? 2 : 6;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = colour;
  const stride = image.width * image.channels;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
