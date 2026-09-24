/**
 * The permission matrix and everything that reads it (architecture §6).
 *
 * §6 says this code is authoritative from M02b, and that any change to it needs
 * a decision row. The guard, `serializeFor`, the route-coverage gate and the
 * generated role-matrix suite all read `MATRIX` and nothing else, so there is
 * one place a permission can be granted and one place to look when asking why
 * somebody can do something.
 */

export {
  ACTIONS,
  COST_FIELDS,
  RESELLER_VISIBLE_FIELDS,
  SCOPES,
  SCOPE_RANK,
  SUBJECTS,
  type Action,
  type CostField,
  type Scope,
  type Subject,
} from './subjects.js';

export {
  BRANCH_TIER_CHECKERS,
  canDecideType,
  canRequestType,
  CHECKER_TYPES,
  REQUESTER_TYPES,
  checkerTier,
  COST_READING_ROLES,
  MATRIX,
  type Rule,
} from './matrix.js';

export {
  canReadCost,
  defineAbilityFor,
  effectiveScope,
  rowInScope,
  scopeFilterFor,
  type AbilityContext,
  type AppAbility,
  type ScopeCondition,
  type ScopedRow,
  type ScopeFilter,
} from './ability.js';

export {
  assertNoCostFields,
  findCostFields,
  serializeFor,
  type SerializeContext,
} from './serialize.js';
