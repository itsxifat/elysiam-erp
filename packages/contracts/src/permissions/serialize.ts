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

/**
 * A plain object, and nothing that merely resembles one.
 *
 * The prototype check is load-bearing. `typeof x === 'object'` is true of a
 * Buffer, a Map, a Set and every class instance, and walking one with
 * `Object.entries` corrupts it silently: a `Buffer.from('PDF')` response came
 * back as `{"0":80,"1":68,"2":70}`, and a Map came back as `{}`. M22 returns
 * Gotenberg PDFs on exactly this path.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Prune with a deny-list: keep everything except the named fields.
 *
 * Recurses through arrays and objects alike, because a cost field nested in
 * `order.lines[3]` is exactly as exposed as one at the top level.
 */
function pruneDenied(value: unknown, denied: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => pruneDenied(entry, denied));
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (denied.has(key)) continue;
    result[key] = pruneDenied(entry, denied);
  }
  return result;
}

/**
 * Prune with an allow-list, which is a genuinely different problem.
 *
 * The obvious implementation — drop any key not on the list — deletes the
 * envelope a response comes in (`{ items: [...] }`), because `items` is not a
 * field of the entity. The obvious repair — keep any key whose value is a
 * container — was worse, and an audit reproduced it failing in **both**
 * directions:
 *
 *   `{ wholesaleCostTiers: ['120000','115000'] }`  survived intact, because
 *   `prune` applied the predicate to object keys only and returned scalars
 *   inside an array untouched. Arrays are precisely the shape a catalog has.
 *
 *   `{ attributes: { colour: 'red' } }`            was emptied to `{}`, even
 *   though `attributes` is on the allow-list and §6 says a reseller may see it
 *   — keeping the container name kept only the name.
 *
 * So the decision is pushed down rather than taken at the key:
 *
 * - an **allow-listed key exposes its whole subtree**. `attributes` is a blob
 *   of product attributes and `images` a list of urls; that is what listing
 *   them means.
 * - a key that is *not* allow-listed is descended into only to look for
 *   allow-listed keys deeper, and every scalar under it is dropped. So an
 *   envelope survives, and `{ costTiers: ['120000'] }` becomes
 *   `{ costTiers: [] }` — empty, which is the safe direction.
 */
function pruneAllowed(value: unknown, allowed: ReadonlySet<string>, exposed: boolean): unknown {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => pruneAllowed(entry, allowed, exposed));
    // Scalars in an array under a key nobody allowed carry data with no name
    // to filter them by, so they go.
    return exposed ? entries : entries.filter((entry) => isPlainObject(entry));
  }

  if (!isPlainObject(value)) return value;
  if (exposed) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (allowed.has(key)) {
      result[key] = entry;
      continue;
    }
    if (Array.isArray(entry) || isPlainObject(entry)) {
      result[key] = pruneAllowed(entry, allowed, false);
    }
  }
  return result;
}

export function serializeFor<T>(context: SerializeContext, subject: Subject, data: T): T {
  // A reseller gets an allow-list, and it is checked first: the deny-list would
  // also hide cost, but "everything except the fields we remembered to hide" is
  // the wrong default for a partner who is not staff.
  if (context.roles.includes('reseller') && !context.isSuperAdmin) {
    if (RESELLER_ALLOWLISTED.has(subject)) {
      return pruneAllowed(data, RESELLER_FIELD_SET, false) as T;
    }
  }

  if (canReadCost(context.roles, context.isSuperAdmin)) return data;

  return pruneDenied(data, COST_FIELD_SET) as T;
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
