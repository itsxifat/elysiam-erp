import { crc32, deflateRawSync } from 'node:zlib';

/**
 * CSV and XLSX for the buyer list export (M11 Build list; acceptance check 2).
 *
 * Written here rather than taken from a spreadsheet library, and the trade is small: the
 * export is one sheet of plain cells, an XLSX file is a zip of five XML documents, and
 * Node ships both halves of a zip writer (`deflateRawSync`, `crc32`). A dependency would
 * bring formulas, styles, charts and a parser — none of which a list of buyers needs, all
 * of which is attack surface on a path that handles personal data.
 *
 * ## Formula injection
 *
 * A buyer's name is text a stranger typed into a landing page. Opened in a spreadsheet, a
 * CSV cell that begins with `=`, `+`, `-` or `@` is a formula, and `=HYPERLINK(…)` in a
 * name column is the classic way a marketing export becomes a phishing link on an
 * employee's screen. So every free-text cell that begins with one of those is prefixed with
 * an apostrophe (OWASP's recommendation). Phone numbers are exempt because they are
 * validated E.164 before they are stored — `+8801711223344` cannot carry a function call —
 * and prefixing them would break the one column marketing actually uploads.
 *
 * XLSX needs no prefix: every text cell is written as an inline string (`t="inlineStr"`),
 * which a spreadsheet never evaluates.
 */

export type CellKind = 'text' | 'number' | 'phone' | 'date';

export interface TabularColumn {
  readonly header: string;
  readonly kind: CellKind;
}

export type TabularCell = string | number | null;

const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvText(value: string, kind: CellKind): string {
  const guarded = kind === 'text' && FORMULA_LEAD.test(value) ? `'${value}` : value;
  // RFC 4180: a field containing a quote, a comma or a line break is quoted, and quotes
  // inside it are doubled. Quoting every text field would be valid too; quoting only when
  // needed keeps a phone column readable in a text editor.
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * UTF-8 with a byte-order mark, CRLF line ends.
 *
 * The BOM is not decoration: without it Excel on Windows reads the file as the system code
 * page, and every Bangla name in the list turns into mojibake.
 */
export function toCsv(
  columns: readonly TabularColumn[],
  rows: readonly (readonly TabularCell[])[],
): Buffer {
  const lines = [columns.map((column) => csvText(column.header, 'text')).join(',')];
  for (const row of rows) {
    lines.push(
      columns
        .map((column, index) => {
          const value = row[index];
          if (value === null || value === undefined) return '';
          if (typeof value === 'number') return String(value);
          return csvText(value, column.kind);
        })
        .join(','),
    );
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join('\r\n')}\r\n`)]);
}

// --- XLSX -------------------------------------------------------------------

/** Characters XML 1.0 cannot carry at all, even escaped. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const XML_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

function xmlText(value: string): string {
  return value
    .replace(XML_FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellXml(reference: string, value: TabularCell, header: boolean): string {
  const style = header ? ' s="1"' : '';
  if (value === null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${String(value)}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(String(value))}</t></is></c>`;
}

function sheetXml(
  columns: readonly TabularColumn[],
  rows: readonly (readonly TabularCell[])[],
): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<sheetData>',
    `<row r="1">${columns
      .map((column, index) => cellXml(`${columnLetter(index)}1`, column.header, true))
      .join('')}</row>`,
  ];
  rows.forEach((row, rowIndex) => {
    const r = rowIndex + 2;
    out.push(
      `<row r="${String(r)}">${columns
        .map((_, index) => cellXml(`${columnLetter(index)}${String(r)}`, row[index] ?? null, false))
        .join('')}</row>`,
    );
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** Two cell formats: plain, and bold for the header row. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function workbookXml(sheetName: string): string {
  // Excel refuses a sheet name over 31 characters or containing any of : \ / ? * [ ].
  const safe = sheetName.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Sheet1';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(safe)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * A zip archive of deflated entries, per PKWARE's APPNOTE (local headers, central
 * directory, end record). No zip64: the export is capped far below 4 GB by the row limit.
 *
 * The DOS timestamp is fixed at 1980-01-01, so the same rows always produce the same bytes
 * — which is what lets a test compare two exports, and costs nothing, because the file's
 * real date is the download's.
 */
export function zip(entries: readonly ZipEntry[]): Buffer {
  // 1980-01-01: year 0 since 1980 in bits 9-15, month 1 in bits 5-8, day 1 in bits 0-4.
  const DOS_DATE = 0x21;
  const DOS_TIME = 0;
  const UTF8_NAMES = 0x0800;

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

export function toXlsx(
  sheetName: string,
  columns: readonly TabularColumn[],
  rows: readonly (readonly TabularCell[])[],
): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheetName), 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(columns, rows), 'utf8') },
  ]);
}

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
