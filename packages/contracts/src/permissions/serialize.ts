import type { MembershipRole } from '../iam.js';
import { canReadCost } from './ability.js';
import { COST_FIELDS, RESELLER_VISIBLE_FIELDS, type Subject } from './subjects.js';

/**
 * Strip every field the caller may not read, on the way out (invariant 5).
 *
 * The rule is "responses go through `serializeFor()`", and the reason it is an
 * invariant rather than a convention is that the failure is invisible: a cost
 * field on a JSON response nobody looks at leaks margin to a reseller for
 * months without a single error.
 *
 * Three properties this has to hold, and each is tested:
 *
 * 1. **It recurses.** Cost hidden at the top level and present in
 *    `order.lines[3].unitCostPoisha` is not hidden.
 * 2. **It fails closed on the reseller path.** A reseller sees an allow-list,
 *    so a field added next year is hidden until somebody decides otherwise.
 * 3. **It does not mutate its input.** The caller may still need the cost —
 *    to post a journal, say — after serializing a response from the same row.
 */

export interface SerializeContext {
  readonly roles: readonly MembershipRole[];
  readonly isSuperAdmin: boolean;
}

const COST_FIELD_SET: ReadonlySet<string> = new Set(COST_FIELDS);
const RESELLER_FIELD_SET: ReadonlySet<string> = new Set(RESELLER_VISIBLE_FIELDS);

/** Subjects a reseller sees through the allow-list rather than the deny-list. */
const RESELLER_ALLOWLISTED: ReadonlySet<Subject> = new Set<Subject>(['Catalog', 'CostedItem']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Walk anything: object, array, or a scalar that is neither.
 *
 * `keep` decides each key. Dates and other class instances are returned as-is
 * rather than walked, because turning a Date into `{}` is a data-loss bug that
 * looks like a serialization quirk.
 */
function prune(value: unknown, keep: (key: string, value: unknown) => boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => prune(entry, keep));
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keep(key, entry)) continue;
    result[key] = prune(entry, keep);
  }
  return result;
}

/**
 * Is this value a container we should look inside rather than a leaf?
 *
 * The allow-list has to answer a question the deny-list does not: a response is
 * usually an envelope — `{ items: [...] }`, `{ order: { lines: [...] } }` — and
 * `items` is not a field of the entity, so a naive allow-list deletes the
 * envelope and returns `{}`. That is exactly what happened when the serializer
 * moved into an interceptor: the reseller got an empty object instead of a
 * filtered catalog.
 *
 * So containers are descended into and leaves are allow-listed. Nothing leaks:
 * a scalar not on the list is dropped wherever it sits, and keeping a container
 * key only keeps its *name*, whose contents are pruned by the same rule one
 * level down. `{ supplierDetails: { cost: 1 } }` survives as
 * `{ supplierDetails: {} }` — ugly, and empty, which is the safe direction.
 */
function isContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

export function serializeFor<T>(context: SerializeContext, subject: Subject, data: T): T {
  // A reseller gets an allow-list, and it is checked first: the deny-list would
  // also hide cost, but "everything except the fields we remembered to hide" is
  // the wrong default for a partner who is not staff.
  if (context.roles.includes('reseller') && !context.isSuperAdmin) {
    if (RESELLER_ALLOWLISTED.has(subject)) {
      return prune(data, (key, value) => RESELLER_FIELD_SET.has(key) || isContainer(value)) as T;
    }
  }

  if (canReadCost(context.roles, context.isSuperAdmin)) return data;

  return prune(data, (key) => !COST_FIELD_SET.has(key)) as T;
}

/**
 * Fail a test if any cost field survived anywhere in a payload.
 *
 * The milestone asks for this as a test utility, and it is deliberately blunt:
 * it walks the whole structure and reports the path, because "no cost fields"
 * asserted only at the top level is the exact bug it exists to catch.
 */
export function findCostFields(data: unknown, path = '$'): string[] {
  if (Array.isArray(data)) {
    return data.flatMap((entry, index) => findCostFields(entry, `${path}[${String(index)}]`));
  }
  if (!isPlainObject(data)) return [];

  const found: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (COST_FIELD_SET.has(key)) found.push(`${path}.${key}`);
    found.push(...findCostFields(value, `${path}.${key}`));
  }
  return found;
}

export function assertNoCostFields(data: unknown): void {
  const leaks = findCostFields(data);
  if (leaks.length > 0) {
    throw new Error(`Cost fields leaked to a role without read:cost: ${leaks.join(', ')}`);
  }
}
