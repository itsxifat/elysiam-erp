import { crc32, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { containsPattern, sizePattern } from '../buyers.repository.js';
import { columnLetter, toCsv, toXlsx, type TabularColumn } from './tabular.js';

/**
 * The buyer export's two file formats, read back byte for byte.
 *
 * The XLSX is unzipped here by a reader written against the same specification the writer
 * was (PKWARE APPNOTE), and every entry's CRC is recomputed — so a writer that produced a
 * file Excel would call corrupt fails here rather than on a marketing manager's laptop.
 */

const COLUMNS: readonly TabularColumn[] = [
  { header: 'Name', kind: 'text' },
  { header: 'Phone', kind: 'phone' },
  { header: 'Orders', kind: 'number' },
];

/** Every entry of a zip, inflated, with its CRC checked. */
function unzip(archive: Buffer): Map<string, string> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localName = archive.readUInt16LE(localOffset + 26);
    const localExtra = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const data = archive.subarray(start, start + compressedSize);
    expect(method).toBe(8);
    const inflated = inflateRawSync(data);
    expect(crc32(inflated)).toBe(crc);
    files.set(name, inflated.toString('utf8'));
    cursor += 46 + nameLength;
  }
  return files;
}

describe('CSV', () => {
  it('starts with a BOM and quotes what RFC 4180 says to', () => {
    const csv = toCsv(COLUMNS, [['Rahima, "Ruma"', '+8801711223344', 3]]).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('Name,Phone,Orders\r\n"Rahima, ""Ruma""",+8801711223344,3\r\n');
  });

  it('defuses a formula in free text and leaves a validated phone alone', () => {
    const csv = toCsv(COLUMNS, [
      ['=HYPERLINK("http://x")', '+8801711223344', 1],
      ['@SUM(A1)', '+8801911223344', 1],
      ['-2+3', '+8801811223344', 1],
    ]).toString('utf8');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`'@SUM(A1)`);
    expect(csv).toContain(`'-2+3`);
    expect(csv).toContain(',+8801711223344,');
  });

  it('keeps Bangla intact', () => {
    const csv = toCsv(COLUMNS, [['রহিমা খাতুন', '+8801711223344', 2]]).toString('utf8');
    expect(csv).toContain('রহিমা খাতুন');
  });
});

describe('XLSX', () => {
  const rows = [
    ['রহিমা খাতুন', '+8801711223344', 2],
    ['=cmd|calc', '+8801911223344', 1],
    ['A & B <co>', '+8801811223344', 5],
  ] as const;
  const archive = toXlsx('Buyers', COLUMNS, rows);
  const files = unzip(archive);

  it('is a well-formed zip of the five parts a workbook needs', () => {
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('writes one row per buyer plus the header, text as inline strings', () => {
    const sheet = files.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet.match(/<row /g)?.length).toBe(rows.length + 1);
    expect(sheet).toContain(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">রহিমা খাতুন</t></is></c>',
    );
    expect(sheet).toContain('<c r="C4"><v>5</v></c>');
    // Escaped, and still text: an inline string is never evaluated as a formula.
    expect(sheet).toContain('A &amp; B &lt;co&gt;');
    expect(sheet).toContain('<t xml:space="preserve">=cmd|calc</t>');
  });

  it('is byte-for-byte deterministic', () => {
    expect(toXlsx('Buyers', COLUMNS, rows).equals(archive)).toBe(true);
  });

  it('names columns the way a spreadsheet does', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });
});

describe('the buyer filters’ patterns', () => {
  it('matches a size only as a variant segment after the sequence number', () => {
    const pattern = new RegExp(sizePattern('M'));
    expect(pattern.test('ELY-SHRT-0042-BLK-M')).toBe(true);
    expect(pattern.test('ELY-SHRT-0042-M-BLK')).toBe(true);
    expect(pattern.test('ELY-0042-M')).toBe(true);
    expect(pattern.test('ELY-SHRT-0042-BLK-ML')).toBe(false);
    expect(pattern.test('M-SHRT-0042-BLK-L')).toBe(false);
    expect(pattern.test('ELY-M-0042-BLK-L')).toBe(false);
    expect(new RegExp(sizePattern('42')).test('ELY-SHOE-0042-BLK')).toBe(false);
    expect(new RegExp(sizePattern('42')).test('ELY-SHOE-0007-BLK-42')).toBe(true);
  });

  it('refuses a size that could smuggle a pattern', () => {
    expect(() => sizePattern('M|L')).toThrow();
    expect(() => sizePattern('.*')).toThrow();
  });

  it('escapes LIKE wildcards in a product fragment', () => {
    expect(containsPattern('50% off_now')).toBe('%50\\% off\\_now%');
  });
});
