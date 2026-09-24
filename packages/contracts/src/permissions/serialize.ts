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
 * A reference that is already on the path we are walking.
 *
 * Every walker here recurses, and a cycle turns that into a stack overflow —
 * which is a 500 on every response of that shape, from the one component whose
 * job is to make responses safe. Found by a test written for something else:
 * `{ sku, self: <itself> }` through `serializeFor` was `RangeError: Maximum
 * call stack size exceeded`, not a leak but an outage.
 *
 * Tracked per *path* rather than per walk, so a value that legitimately
 * appears twice in a response — the same nested object under two keys, which
 * an ORM with relations produces routinely — is serialized both times. Only a
 * reference that contains itself is dropped, which is what `JSON.stringify`
 * would refuse to do anything with anyway.
 */
type Seen = Set<object>;

function isCycle(value: unknown, seen: Seen): value is object {
  return typeof value === 'object' && value !== null && seen.has(value);
}

/**
 * Prune with a deny-list: keep everything except the named fields.
 *
 * Recurses through arrays and objects alike, because a cost field nested in
 * `order.lines[3]` is exactly as exposed as one at the top level.
 */
function pruneDenied(value: unknown, denied: ReadonlySet<string>, seen: Seen = new Set()): unknown {
  if (isCycle(value, seen)) return undefined;

  if (Array.isArray(value)) {
    seen.add(value);
    const mapped = value.map((entry) => pruneDenied(entry, denied, seen));
    seen.delete(value);
    return mapped;
  }

  if (!isPlainObject(value)) return value;

  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (denied.has(key)) continue;
    const pruned = pruneDenied(entry, denied, seen);
    // A dropped cycle leaves the key out rather than setting it to undefined,
    // so the response shape matches what JSON would have produced.
    if (pruned !== undefined || entry === undefined) result[key] = pruned;
  }
  seen.delete(value);
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
function pruneAllowed(
  value: unknown,
  allowed: ReadonlySet<string>,
  exposed: boolean,
  seen: Seen = new Set(),
): unknown {
  if (isCycle(value, seen)) return undefined;

  if (Array.isArray(value)) {
    seen.add(value);
    const entries = value.map((entry) => pruneAllowed(entry, allowed, exposed, seen));
    seen.delete(value);
    // Scalars in an array under a key nobody allowed carry data with no name
    // to filter them by, so they go.
    return exposed ? entries : entries.filter((entry) => isPlainObject(entry));
  }

  if (!isPlainObject(value)) return value;
  if (exposed) return value;

  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (allowed.has(key)) {
      // An allow-listed key exposes its subtree, so a cycle inside one is
      // still a cycle — checked rather than copied by reference.
      result[key] = isCycle(entry, seen) ? undefined : entry;
      continue;
    }
    if (Array.isArray(entry) || isPlainObject(entry)) {
      const pruned = pruneAllowed(entry, allowed, false, seen);
      if (pruned !== undefined) result[key] = pruned;
    }
  }
  seen.delete(value);
  return result;
}

export function serializeFor<T>(context: SerializeContext, subject: Subject, data: T): T {
  /*
   * A reseller gets the allow-list **and then the deny-list**, in that order.
   *
   * Running only the allow-list was a hole, and an adversarial pass found it
   * after the allow-list itself had been fixed twice. "An allow-listed key
   * exposes its whole subtree" is right for `attributes` and `images` — but a
   * subtree is not a leaf, and cost can sit inside one. With `sku` on the list,
   * `{ sku: { skuCode, wacPoisha } }` handed a reseller the weighted average
   * cost, and `attributes` carrying a supplier-fed `cogsPoisha` did the same.
   *
   * Reproduced against the built package, same payload, same route:
   *   reseller -> $.items[0].sku.wacPoisha, $.items[0].attributes.cogsPoisha
   *   sales    -> (nothing)
   *
   * The least trusted principal in the system was receiving strictly more cost
   * than a staff role, because the reseller branch returned before the deny-list
   * ever ran. Invariant 5 is not "resellers see an allow-list"; it is "roles
   * without read:cost never receive cost fields", and that has to hold on every
   * path, including the narrower one.
   */
  if (context.roles.includes('reseller') && !context.isSuperAdmin) {
    if (RESELLER_ALLOWLISTED.has(subject)) {
      const visible = pruneAllowed(data, RESELLER_FIELD_SET, false);
      return pruneDenied(visible, COST_FIELD_SET) as T;
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
export function findCostFields(data: unknown, path = '$', seen: Seen = new Set()): string[] {
  // The detector recurses too, so it overflows on exactly the input the
  // pruners do. A cycle cannot hide a cost field the first pass did not
  // already see, so stopping is free.
  if (isCycle(data, seen)) return [];

  if (Array.isArray(data)) {
    seen.add(data);
    const found = data.flatMap((entry, index) =>
      findCostFields(entry, `${path}[${String(index)}]`, seen),
    );
    seen.delete(data);
    return found;
  }

  /*
   * Deliberately looser than `isPlainObject`.
   *
   * The pruners skip anything that is not a plain object, on purpose: walking a
   * Buffer turns a PDF into `{"0":80,"1":68}`. But a *detector* that shares that
   * blind spot cannot see what the pruner cannot prune, which would leave the
   * two controls blind in the same place. This only reads, so it can look
   * everywhere, and `assertNoCostFields` stays able to fail on a class instance
   * carrying cost even though `serializeFor` would pass it through.
   */
  if (typeof data !== 'object' || data === null) return [];
  if (data instanceof Date || ArrayBuffer.isView(data)) return [];

  seen.add(data);
  const found: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (COST_FIELD_SET.has(key)) found.push(`${path}.${key}`);
    found.push(...findCostFields(value, `${path}.${key}`, seen));
  }
  seen.delete(data);
  return found;
}

export function assertNoCostFields(data: unknown): void {
  const leaks = findCostFields(data);
  if (leaks.length > 0) {
    throw new Error(`Cost fields leaked to a role without read:cost: ${leaks.join(', ')}`);
  }
}
