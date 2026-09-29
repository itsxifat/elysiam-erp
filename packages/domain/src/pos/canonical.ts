/**
 * One spelling of a document, for comparing two deliveries of it.
 *
 * A till re-sends a sale whenever it cannot tell whether the last attempt landed —
 * the reply was lost, the tab was closed, the connection dropped mid-flight. The
 * server has to tell "the same sale again" (answer with what it already recorded)
 * from "a different sale under a reused id" (refuse: posting either one silently
 * would make the books disagree with one of the two receipts). Hashing the parsed
 * payload in this canonical form is what makes that comparison exact: keys sorted,
 * no whitespace, and bigints as decimal strings, so key order on the wire and the
 * JSON library on the client cannot make one sale look like two.
 *
 * Pure and dependency-free; the server applies SHA-256 to the result.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('A canonical document has finite numbers.');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalise a ${typeof value}.`);
}
