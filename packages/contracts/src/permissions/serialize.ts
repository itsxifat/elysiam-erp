import type { MembershipRole } from '../iam.js';
import { canReadCost } from './ability.js';
import {
  COST_FIELDS,
  RESELLER_VISIBLE_FIELDS,
  STOREFRONT_VISIBLE_FIELDS,
  type Subject,
} from './subjects.js';

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
const STOREFRONT_FIELD_SET: ReadonlySet<string> = new Set(STOREFRONT_VISIBLE_FIELDS);

/** Subjects a reseller sees through the allow-list rather than the deny-list. */
const RESELLER_ALLOWLISTED: ReadonlySet<Subject> = new Set<Subject>(['Catalog', 'CostedItem']);

/** Roles a brand's partners hold, as opposed to its staff (§6). */
const PARTNER_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>([
  'reseller',
  'investor',
]);

/** A reseller with no staff role: the caller the allow-list is for. */
function actsAsReseller(context: SerializeContext): boolean {
  if (context.isSuperAdmin || !context.roles.includes('reseller')) return false;
  return context.roles.every((role) => PARTNER_ROLES.has(role));
}

/**
 * A plain object, and nothing that merely resembles one.
 *
 * The prototype check is load-bearing. `typeof x === 'object'` is true of a
 * Buffer, a Map, a Set and every class instance, and walking one with
 * `Object.entries` corrupts it silently: a `Buffer.from('PDF')` response came
 * back as `{"0":80,"1":68,"2":70}`, and a Map came back as `{}`. M22 returns
 * Gotenberg PDFs on exactly this path. Callers `normalise` first, so by the
 * time this runs a class instance has already become a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Binary, collections and dates: opaque on purpose, and passed through.
 *
 * None can carry a named field on the wire — JSON renders a Map or a Set as
 * `{}`, a Date as a string, a Buffer as bytes — so passing them through leaks
 * nothing, and walking them would corrupt them.
 */
function isOpaque(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Date
  );
}

/**
 * Turn any other object into what JSON will make of it, so it can be judged.
 *
 * **Fail closed.** This used to walk plain objects only and return everything
 * else untouched, so a class instance — a row mapped into a DTO class, anything
 * with a prototype — carried `unitCostPoisha` straight past the serializer,
 * because `JSON.stringify` happily emits a class instance's own fields. Now an
 * object is judged as what goes on the wire: its `toJSON()` if it has one,
 * otherwise its own enumerable fields.
 */
function normalise(value: unknown, depth = 0): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  if (isOpaque(value)) return value;

  // Before the plain-object test: `{ toJSON() {…} }` is a plain object whose
  // own keys say nothing about what it serializes to.
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    /*
     * **Fail closed when the chain is exhausted.** This used to return the
     * object *with* its `toJSON` still attached once `depth` hit 8, and the
     * pruners then copied that method into their output. Fastify's
     * `JSON.stringify` calls it, and whatever it returns replaces the pruned
     * object wholesale — so a nine-deep chain, or the classic self-returning
     * `obj.toJSON = () => obj`, put every denied cost field back on the wire
     * while the returned object still looked pruned to anything inspecting its
     * own keys. Reproduced both ways.
     *
     * A value whose serializer we cannot reach the end of is a value we cannot
     * judge, and invariant 5 does not have a "probably fine" case.
     */
    if (depth >= 8) return undefined;
    return normalise((toJSON as () => unknown).call(value), depth + 1);
  }
  if (isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value));
}

/**
 * A reference already on the path being walked.
 *
 * Every walker in this file recurses, and a structure containing itself turned
 * that into `RangeError: Maximum call stack size exceeded` — a 500 on every
 * response of that shape, produced by the one component whose job is to make
 * responses safe. Reproduced against the built package with
 * `{ sku: 'A', wacPoisha: '1', self: <itself> }`.
 *
 * Not exotic: an ORM with relations hands back parents holding children
 * holding the parent, and M07's stock movements and M09's supply lines are
 * both shaped that way. `JSON.stringify` refuses such a value outright, so
 * dropping the back-reference costs nothing a response could have carried.
 *
 * Tracked per **path**, not per walk: a value that legitimately appears twice
 * — the same nested object under two keys, which an ORM produces constantly —
 * is serialized both times. Only a reference that contains itself is dropped.
 */
type Seen = Set<object>;

function isCycle(value: unknown, seen: Seen): boolean {
  return typeof value === 'object' && value !== null && seen.has(value);
}

/**
 * Set a key without `__proto__` meaning what it usually means.
 *
 * `result[key] = value` for that one key invokes the `Object.prototype.__proto__`
 * setter and replaces the result's prototype instead of adding a property.
 * `normalise` happens to undo the damage today — it rebuilds a non-plain object
 * from its own entries — but that is an accident of ordering, and the accident
 * is the only thing standing between a `__proto__` key in a supplier-fed
 * `attributes` blob and a serializer that returns objects its own shape checks
 * refuse to look at. `defineProperty` creates an own property for any key.
 */
function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Prune with a deny-list: keep everything except the named fields.
 *
 * Recurses through arrays and objects alike, because a cost field nested in
 * `order.lines[3]` is exactly as exposed as one at the top level.
 */
function pruneDenied(input: unknown, denied: ReadonlySet<string>, seen: Seen = new Set()): unknown {
  if (isCycle(input, seen)) return undefined;

  const value = normalise(input);
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
    // A function is never serialized by `JSON.stringify` — except `toJSON`,
    // which it *calls*, handing the caller a value this pruner never saw.
    // Dropping all of them is the general form of that fix and costs nothing:
    // none of them could have reached the wire as data anyway.
    if (typeof entry === 'function') continue;
    const pruned = pruneDenied(entry, denied, seen);
    // A dropped cycle leaves the key out rather than setting it undefined, so
    // the response matches what JSON would have produced.
    if (pruned !== undefined || entry === undefined) assign(result, key, pruned);
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
  input: unknown,
  allowed: ReadonlySet<string>,
  exposed: boolean,
  seen: Seen = new Set(),
): unknown {
  if (isCycle(input, seen)) return undefined;

  const value = exposed ? input : normalise(input);
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
    if (typeof entry === 'function') continue;
    if (allowed.has(key)) {
      // An allow-listed key exposes its whole subtree, so a cycle inside one
      // is still a cycle — checked rather than copied by reference.
      assign(result, key, isCycle(entry, seen) ? undefined : entry);
      continue;
    }
    const inner = normalise(entry);
    if (Array.isArray(inner) || isPlainObject(inner)) {
      const pruned = pruneAllowed(inner, allowed, false, seen);
      if (pruned !== undefined) assign(result, key, pruned);
    }
  }
  seen.delete(value);
  return result;
}

export function serializeFor<T>(context: SerializeContext, subject: Subject, data: T): T {
  // A reseller gets an allow-list, and it is checked first: the deny-list would
  // also hide cost, but "everything except the fields we remembered to hide" is
  // the wrong default for a partner who is not staff. Only someone here as a
  // partner alone reads through it (D-450): a person who also holds a staff role
  // reads the catalog as staff, with cost still hidden unless a staff role reads
  // it. Narrowing them to the reseller's view broke the staff screens they use.
  if (actsAsReseller(context)) {
    if (RESELLER_ALLOWLISTED.has(subject)) {
      // Then the cost deny-list over what survived. An allow-listed key exposes
      // its whole subtree, and `attributes: { wacPoisha }` walked straight out
      // through it. A reseller never holds read:cost, so there is no reading of
      // the allow-list under which cost belongs in its output.
      return pruneDenied(pruneAllowed(data, RESELLER_FIELD_SET, false), COST_FIELD_SET) as T;
    }
  }

  if (canReadCost(context.roles, context.isSuperAdmin)) return data;

  return pruneDenied(data, COST_FIELD_SET) as T;
}

/**
 * Prune with an allow-list applied at **every** depth (M33, D-506).
 *
 * Unlike `pruneAllowed`, an allowed key does not expose its subtree: the subtree is judged
 * key by key as well, so `{ product: { variants: [{ wacPoisha }] } }` loses `wacPoisha`
 * because `wacPoisha` is not on the list, not because somebody remembered it is cost.
 * Scalars inside an array are kept (a size chart's cells, a product's tags): an array has no
 * keys, and its key was judged one level up.
 */
function pruneStrict(
  input: unknown,
  allowed: ReadonlySet<string>,
  seen: Seen = new Set(),
): unknown {
  if (isCycle(input, seen)) return undefined;
  const value = normalise(input);
  if (Array.isArray(value)) {
    seen.add(value);
    const entries = value
      .map((entry) => pruneStrict(entry, allowed, seen))
      .filter((entry) => entry !== undefined);
    seen.delete(value);
    return entries;
  }
  if (!isPlainObject(value)) return typeof value === 'function' ? undefined : value;

  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key) || typeof entry === 'function') continue;
    const pruned = pruneStrict(entry, allowed, seen);
    if (pruned !== undefined || entry === undefined) assign(result, key, pruned);
  }
  seen.delete(value);
  return result;
}

/**
 * What the brand's website may receive (M33, D-506): the storefront allow-list at every
 * depth, then the cost deny-list. The website has no role and no session, so this is not a
 * function of an ability: it is the one shape every storefront response leaves in.
 */
export function serializeForStorefront<T>(data: T): T {
  return pruneDenied(pruneStrict(data, STOREFRONT_FIELD_SET), COST_FIELD_SET) as T;
}

/**
 * Fail a test if any cost field survived anywhere in a payload.
 *
 * The milestone asks for this as a test utility, and it is deliberately blunt:
 * it walks the whole structure and reports the path, because "no cost fields"
 * asserted only at the top level is the exact bug it exists to catch.
 */
export function findCostFields(input: unknown, path = '$', seen: Seen = new Set()): string[] {
  // The detector recurses too, so it overflowed on exactly the input the
  // pruners did — and it is what every "no cost leaked" assertion runs
  // through. A cycle cannot hide a field the first pass has not already seen,
  // so stopping costs nothing.
  if (isCycle(input, seen)) return [];

  const data = normalise(input);
  if (Array.isArray(data)) {
    seen.add(data);
    const found = data.flatMap((entry, index) =>
      findCostFields(entry, `${path}[${String(index)}]`, seen),
    );
    seen.delete(data);
    return found;
  }
  if (!isPlainObject(data)) return [];

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
