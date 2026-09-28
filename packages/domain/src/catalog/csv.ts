/**
 * CSV parsing for the catalog importer (M06 acceptance check 4).
 *
 * Hand-written rather than a dependency, and the reason is the failure mode this
 * importer has to survive: the files come out of Excel on a Windows machine in
 * Dhaka, so they carry a UTF-8 BOM, CRLF line endings, quoted fields containing
 * commas, and Bangla product names. A parser that splits on `,` handles none of
 * those and fails *quietly* — a quoted `"Shirt, cotton"` becomes two columns and
 * every field after it shifts by one, so the price lands in the size column and
 * the row still looks plausible.
 *
 * So this is RFC 4180 with the two concessions reality demands (a BOM, and bare
 * CR as a line ending), and nothing else. What it deliberately does not do is
 * guess: no type coercion, no trimming of quoted values, no "helpfully" skipping
 * blank lines in the middle of a file. Every interpretation happens one layer up,
 * where an error can be reported against a row number.
 */

export class CsvError extends Error {
  constructor(
    message: string,
    /** 1-based, counting the header. */
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

/** One data row, keyed by header name, plus where it came from. */
export interface CsvRow {
  /** 1-based line in the file, header included, so it matches what Excel shows. */
  readonly line: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface CsvTable {
  readonly headers: readonly string[];
  readonly rows: readonly CsvRow[];
}

/** Rows above this are refused outright rather than parsed and then rejected. */
export const CSV_MAX_ROWS = 5000;

/**
 * Split a CSV into fields, tracking the line each record started on.
 *
 * One pass, one state flag. The alternative — a regular expression — cannot
 * express "a quote inside a quoted field is written as two quotes" without
 * either backtracking catastrophically on a malformed file or silently accepting
 * one. A malformed file is exactly what an importer receives.
 */
function records(text: string): { line: number; fields: string[] }[] {
  // Excel writes a BOM. Left in place it becomes part of the first header name,
  // so `sku` is not found and every row reports a missing column.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const out: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let started = false;

  const endField = () => {
    fields.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    out.push({ line: recordLine, fields });
    fields = [];
    started = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? '';
    if (!started) {
      recordLine = line;
      started = true;
    }

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (character === '\n') line += 1;
        field += character;
      }
      continue;
    }

    switch (character) {
      case '"':
        if (field !== '') {
          throw new CsvError(
            'A quote may only open a field, not appear inside an unquoted one.',
            line,
          );
        }
        quoted = true;
        break;
      case ',':
        endField();
        break;
      case '\r':
        // CRLF, and lone CR from very old exports.
        if (input[index + 1] === '\n') index += 1;
        endRecord();
        line += 1;
        break;
      case '\n':
        endRecord();
        line += 1;
        break;
      default:
        field += character;
    }
  }

  if (quoted) throw new CsvError('The file ends inside a quoted field.', line);
  if (started) endRecord();

  return out;
}

/**
 * Parse a CSV into named rows.
 *
 * A row whose field count differs from the header's is an error *for that row*,
 * not for the file: check 4 asks for row-level errors, and a single stray comma
 * on line 300 must not cost the operator the other 4,999 rows of feedback. So
 * the shape problem is recorded on the row and the caller reports it with the
 * rest.
 */
export function parseCsv(text: string): CsvTable {
  const parsed = records(text);
  if (parsed.length === 0) throw new CsvError('The file is empty.', 1);

  const first = parsed[0];
  if (first === undefined) throw new CsvError('The file is empty.', 1);

  const headers = first.fields.map((header) => header.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) {
    throw new CsvError('Two columns have the same name.', 1);
  }
  if (headers.some((header) => header === '')) {
    throw new CsvError('A column has no name.', 1);
  }

  const dataRecords = parsed.slice(1).filter(
    // A trailing newline produces one empty record. Dropping only that shape —
    // a single empty field — rather than "any row that looks blank", because a
    // genuinely blank row in the middle of a file is a mistake worth reporting.
    (record) => !(record.fields.length === 1 && record.fields[0] === ''),
  );

  if (dataRecords.length > CSV_MAX_ROWS) {
    throw new CsvError(
      `That file has ${String(dataRecords.length)} rows; the importer takes ${String(CSV_MAX_ROWS)} at a time.`,
      1,
    );
  }

  const rows: CsvRow[] = dataRecords.map((record) => {
    const values: Record<string, string> = {};
    headers.forEach((header, index) => {
      values[header] = record.fields[index] ?? '';
    });
    // Recorded so the caller can report it per row. Extra fields are kept out of
    // `values` rather than dropped silently under a made-up column name.
    if (record.fields.length !== headers.length) {
      values.__fieldCount = String(record.fields.length);
    }
    return { line: record.line, values };
  });

  return { headers, rows };
}

/** The columns a table must have, checked before any row is looked at. */
export function missingColumns(table: CsvTable, required: readonly string[]): readonly string[] {
  return required.filter((column) => !table.headers.includes(column));
}
