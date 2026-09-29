import { type SettlementFileRow } from './settlement.js';

/**
 * What makes two fetched statements "the same statement" (M15: "settlement fetch is
 * idempotent").
 *
 * A courier API that returns statements is asked on a schedule, and every schedule asks
 * again about a window it has already seen — so the same statement arrives over and over,
 * and the second arrival must neither create a second batch nor, through that batch, post
 * twice. The courier's own statement number is the obvious key, and migration 0051's unique
 * index already holds on it; this is the key for the statements that carry none, and the
 * belt to that brace for the ones that do.
 *
 * The canonical form is the statement's reference, its date, and its rows **sorted** —
 * a courier that returns the same rows in a different order on the second call has sent
 * the same statement. Row numbers are left out for the same reason: they are positions,
 * and positions are exactly what changes between two otherwise identical responses.
 *
 * The digest itself is taken by the caller (it needs `node:crypto`, and this package does
 * no I/O and imports nothing platform-specific). What is fixed here is *what* is hashed,
 * so the fetch job and a test agree on it byte for byte.
 */
export function canonicalStatement(input: {
  readonly reference: string | null;
  readonly settlementDate: string;
  readonly rows: readonly SettlementFileRow[];
}): string {
  const rows = input.rows
    .map((row) =>
      [
        row.consignmentNo.trim().toUpperCase(),
        (row.reference ?? '').trim().toUpperCase(),
        row.codCollectedPoisha.toString(),
        row.deliveryChargePoisha.toString(),
        row.returnChargePoisha.toString(),
        row.otherChargePoisha.toString(),
        row.netPoisha === null ? '' : row.netPoisha.toString(),
      ].join(','),
    )
    .sort();
  return [
    'v1',
    (input.reference ?? '').trim(),
    input.settlementDate,
    String(rows.length),
    ...rows,
  ].join('\n');
}
