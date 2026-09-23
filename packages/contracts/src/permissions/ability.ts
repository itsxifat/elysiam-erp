import {
  AbilityBuilder,
  createMongoAbility,
  type ForcedSubject,
  type MongoAbility,
  type MongoQuery,
} from '@casl/ability';

import type { MembershipRole } from '../iam.js';
import { COST_READING_ROLES, MATRIX } from './matrix.js';
import { SCOPE_RANK, type Action, type Scope, type Subject } from './subjects.js';

/**
 * Turn a request context into an ability (architecture §6).
 *
 * CASL does the matching; the matrix does the deciding. Nothing here encodes a
 * permission — if a rule is not in `MATRIX`, no amount of context produces it.
 */

/**
 * `manage` and `all` are CASL's own wildcards, not entries in our matrix.
 * They exist here for exactly one caller — the super_admin branch below — and
 * are deliberately not in `ACTIONS` or `SUBJECTS`, so no rule can be written
 * against them by accident.
 */
/**
 * A row tagged with its subject, as `subject('Order', row)` produces.
 *
 * Needed in the union so `ability.can('read', subject('Order', row))` type
 * checks — which is the call that actually evaluates a scoped rule. Without
 * it only the bare-string form compiles, and the bare form ignores conditions,
 * so every `own` and `branch` rule would look like it denied everything.
 */
type TaggedSubject = ForcedSubject<Subject>;

export type AppAbility = MongoAbility<[Action | 'manage', Subject | 'all' | TaggedSubject]>;

/**
 * Conditions, as CASL wants them.
 *
 * Our subjects are string literals rather than classes, so CASL cannot infer
 * the shape of a row and narrows its query type to `never`. Declaring the
 * conditions as a plain `MongoQuery` is the documented way to say "these are
 * field names on a record you have no type for" — the matching is still CASL's.
 */
type Conditions = MongoQuery;

export interface AbilityContext {
  readonly roles: readonly MembershipRole[];
  readonly isSuperAdmin: boolean;
  readonly userId: string;
  /** Empty means the whole org, not "no branches" (§6). */
  readonly branchIds: readonly string[];
}

/**
 * The conditions a scope implies, as one rule each.
 *
 * `own` and `branch` become CASL conditions, which is what makes them real
 * rather than advisory: `ability.can('read', subject(...))` on a row from
 * another branch answers false, and the same rule generates the SQL filter.
 *
 * **A list, not a single `$or` query, and this is load-bearing.** CASL's
 * default matcher does not implement a top-level `$or`, and it does not throw
 * on one either — it silently evaluates to false. A rule written
 * `{ $or: [{ createdBy }, { assignedTo }] }` therefore denies *everything*,
 * including the rows it was meant to allow. Verified against @casl/ability 7:
 * both the createdBy and the assignedTo row answered false.
 *
 * That failure mode is worse than it first looks. The symptom is "sales cannot
 * see their own orders", and the obvious fix is to drop the condition — which
 * turns an `own` rule into an `org` one and hands every order to every agent.
 * So the union is expressed the way CASL actually unions rules: several rules
 * for the same action, any of which may match.
 *
 * `branch` with an empty scope list is the whole org, per §6 — so it produces
 * no condition at all rather than `branch_id in ()`, which would match nothing
 * and silently hide every row from a branch manager with no branches assigned.
 */
function conditionsFor(scope: Scope, context: AbilityContext): Conditions[] {
  if (scope === 'own') {
    return [{ createdBy: context.userId }, { assignedTo: context.userId }];
  }

  if (scope === 'branch' && context.branchIds.length > 0) {
    return [{ branchId: { $in: [...context.branchIds] } }];
  }

  return [];
}

export function defineAbilityFor(context: AbilityContext): AppAbility {
  // Built untyped and cast once at the end.
  //
  // CASL infers the shape of a row from the subject type, and ours are string
  // literals — there is no `CostedItem` class for it to read `branchId` off —
  // so it narrows the condition type to `never` and rejects every query. The
  // alternative is declaring a class per subject purely to satisfy the
  // inference, which would put a second, drifting definition of every row shape
  // next to the Drizzle schema. The matrix is fully typed, which is where it
  // matters; this function is the one place that is not.
  const { can, build } = new AbilityBuilder(createMongoAbility);

  const grant = (action: Action | 'manage', subject: Subject | 'all', conditions: Conditions[]) => {
    if (conditions.length === 0) {
      can(action, subject);
      return;
    }
    // One rule per condition. CASL ORs its own rules; see conditionsFor.
    for (const condition of conditions) can(action, subject, condition);
  };

  if (context.isSuperAdmin) {
    // §5 exception 3. Not a long list of grants but a different question, and
    // writing it as a matrix row would mean every new subject needed
    // remembering to add super_admin to — the failure mode being that the one
    // account meant to see everything quietly stops seeing the newest thing.
    grant('manage', 'all', []);
    return build() as unknown as AppAbility;
  }

  for (const role of context.roles) {
    for (const rule of MATRIX[role] ?? []) {
      const conditions = conditionsFor(rule.scope, context);
      // Annotated because `Array.isArray` on a `readonly Action[] | Action`
      // widens the element type to `any` — which would then flow into `grant`
      // unchecked, and a typo'd action silently denies rather than failing.
      const actions: readonly Action[] = Array.isArray(rule.action) ? rule.action : [rule.action];

      for (const action of actions) grant(action, rule.subject, conditions);
    }
  }

  return build() as unknown as AppAbility;
}

/**
 * The widest scope these roles hold for an action on a subject.
 *
 * Roles are additive: someone who is `sales` in one org and `branch_manager`
 * in another holds both rule sets while acting in a single org, and the union
 * is what applies. Returns null when no role grants it at all.
 */
export function effectiveScope(
  roles: readonly MembershipRole[],
  action: Action,
  subject: Subject,
): Scope | null {
  let best: Scope | null = null;

  for (const role of roles) {
    for (const rule of MATRIX[role] ?? []) {
      if (rule.subject !== subject) continue;
      const actions = Array.isArray(rule.action) ? rule.action : [rule.action];
      if (!(actions as Action[]).includes(action)) continue;

      if (best === null || SCOPE_RANK[rule.scope] > SCOPE_RANK[best]) best = rule.scope;
    }
  }

  return best;
}

/** Whether these roles may read cost fields at all (§6, invariant 5). */
export function canReadCost(roles: readonly MembershipRole[], isSuperAdmin: boolean): boolean {
  if (isSuperAdmin) return true;
  return roles.some((role) => COST_READING_ROLES.includes(role));
}
