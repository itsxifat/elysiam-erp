import type { OrderStatus } from './state.js';

/**
 * One person handles each order (M41, D-710 to D-712, D-718, D-719).
 *
 * The owner is the order's `assigned_to`. These rules are the whole of what "handled by
 * somebody else" means, so the server's one gate and the console's warning read the same
 * answer.
 */

/**
 * The desk's acts on an order, which the owner's name guards.
 *
 * The hub's fulfilment moves (pack, ship, deliver, returns, the packing station, the courier)
 * are not here: once an order is confirmed it is the hub's work, and the hub would otherwise
 * have to acknowledge the sales agent on every parcel (D-710).
 */
export const OWNER_GATED_ACTS = [
  'edit',
  'confirm',
  'hold',
  'release_hold',
  'cancel',
  'exchange',
  'advance',
  'call',
] as const;
export type OwnerGatedAct = (typeof OWNER_GATED_ACTS)[number];

export type OwnershipVerdict =
  /** Nobody holds it, or the caller does. */
  | { readonly kind: 'free' }
  /** Somebody else holds it and the caller has not acknowledged them. */
  | { readonly kind: 'refused'; readonly ownerId: string }
  /** Somebody else holds it, the caller said they know, and the owner will be told. */
  | { readonly kind: 'acknowledged'; readonly ownerId: string };

export function ownershipVerdict(input: {
  readonly ownerId: string | null;
  readonly callerId: string;
  readonly acknowledged: boolean;
}): OwnershipVerdict {
  if (input.ownerId === null || input.ownerId === input.callerId) return { kind: 'free' };
  return input.acknowledged
    ? { kind: 'acknowledged', ownerId: input.ownerId }
    : { kind: 'refused', ownerId: input.ownerId };
}

/** The roles that may reassign or release anybody's order in their scope (D-712). */
export const SUPERVISOR_ROLES = ['org_admin', 'branch_manager'] as const;

export function isSupervisor(roles: readonly string[], isSuperAdmin: boolean): boolean {
  return (
    isSuperAdmin || roles.some((role) => (SUPERVISOR_ROLES as readonly string[]).includes(role))
  );
}

export type AssignmentChange =
  /** The order is already where it was asked to go. */
  | 'unchanged'
  /** The caller takes an order nobody holds. */
  | 'take'
  /** The owner gives it to a colleague. */
  | 'hand_over'
  /** A supervisor gives somebody's order, or a queued one, to a person. */
  | 'reassign'
  /** Back to the unassigned queue, by its owner or a supervisor. */
  | 'release';

export type AssignmentDecision =
  | { readonly allowed: true; readonly change: AssignmentChange }
  | { readonly allowed: false; readonly reason: 'not_owner' };

/**
 * May this caller move this order to `target` (a person, or null for the queue)?
 *
 * The owner may release or hand over their own order. A supervisor may do either to anyone's,
 * and route a queued order to a person. Anybody else may only take a queued order for
 * themselves; handing a colleague's order on, or pushing queued work onto a colleague, is a
 * supervisor's call.
 */
export function assignmentDecision(input: {
  readonly ownerId: string | null;
  readonly callerId: string;
  readonly target: string | null;
  readonly supervisor: boolean;
}): AssignmentDecision {
  const { ownerId, callerId, target, supervisor } = input;
  if (target === ownerId) return { allowed: true, change: 'unchanged' };
  if (ownerId === null) {
    if (target === callerId) return { allowed: true, change: 'take' };
    return supervisor
      ? { allowed: true, change: 'reassign' }
      : { allowed: false, reason: 'not_owner' };
  }
  if (ownerId === callerId) {
    return { allowed: true, change: target === null ? 'release' : 'hand_over' };
  }
  if (!supervisor) return { allowed: false, reason: 'not_owner' };
  return { allowed: true, change: target === null ? 'release' : 'reassign' };
}

// --- verification calls ---------------------------------------------------------------

export const CALL_OUTCOMES = ['reached', 'no_answer', 'busy', 'wrong_number', 'call_back'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** How far ahead a call-back may be set (D-718). */
export const CALL_BACK_MAX_DAYS = 30;

/** A call-back a minute in the past is a clock difference, not a mistake. */
const CALL_BACK_SKEW_MS = 60_000;

/** The statuses in which a verification call can be logged: the desk's own. */
export const CALLABLE_STATUSES: readonly OrderStatus[] = ['pending', 'on_hold', 'confirmed'];

/** Why a call attempt cannot be recorded as given, or null when it can. */
export function callAttemptProblem(input: {
  readonly outcome: CallOutcome;
  readonly callBackAt: Date | null;
  readonly now: Date;
}): string | null {
  if (input.outcome !== 'call_back') {
    return input.callBackAt === null ? null : 'Only a call-back has a time to call again.';
  }
  if (input.callBackAt === null) return 'Say when to call back.';
  const at = input.callBackAt.getTime();
  if (Number.isNaN(at)) return 'That is not a usable time.';
  if (at < input.now.getTime() - CALL_BACK_SKEW_MS) return 'A call-back cannot be in the past.';
  if (at > input.now.getTime() + CALL_BACK_MAX_DAYS * 86_400_000) {
    return `A call-back can be at most ${String(CALL_BACK_MAX_DAYS)} days ahead.`;
  }
  return null;
}

// --- the hub's stages -----------------------------------------------------------------

export const HUB_STAGES = ['to_print', 'packing', 'packed', 'handed_over'] as const;
export type HubStage = (typeof HUB_STAGES)[number];

/**
 * Where an order is at the fulfilment hub, for the desk that sold it (check 5).
 *
 * Confirmed orders wait to have their slip printed, then are being packed; packed ones wait for
 * the courier; from the handover on they are out of the hub. Orders the hub has not received
 * (pending, on hold) or will never send (cancelled) have no stage.
 */
export function hubStageOf(input: {
  readonly status: string;
  readonly slipPrintedAt: string | Date | null;
}): HubStage | null {
  switch (input.status) {
    case 'confirmed':
      return input.slipPrintedAt === null ? 'to_print' : 'packing';
    case 'packed':
      return 'packed';
    case 'shipped':
    case 'delivered':
    case 'partially_delivered':
    case 'return_in_transit':
    case 'returned':
      return 'handed_over';
    default:
      return null;
  }
}

/** The statuses an order counts towards its owner's open load (D-716). */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['pending', 'on_hold'];

/** A role a person holds in the brand, and the branches it is limited to (empty: all). */
export interface RoleScope {
  readonly role: string;
  readonly branchIds: readonly string[];
}

/**
 * Can this person hold an order of this branch (null: the desk's, belonging to none)? (D-712)
 *
 * Only someone who would still see the order once it is theirs: a sales agent (their own
 * orders), an org admin or the warehouse (the whole brand), or a branch manager whose branches
 * include the order's, or who is not limited to branches at all. Anybody else would be an
 * owner nobody can reach, gating every colleague by a name they cannot hand back.
 */
export function canHoldOrder(scopes: readonly RoleScope[], branchId: string | null): boolean {
  return scopes.some((scope) => {
    if (scope.role === 'sales' || scope.role === 'org_admin' || scope.role === 'warehouse') {
      return true;
    }
    if (scope.role !== 'branch_manager') return false;
    return (
      scope.branchIds.length === 0 || (branchId !== null && scope.branchIds.includes(branchId))
    );
  });
}

/** The statuses in which an order still has desk work, so taking it means something. */
export const TAKEABLE_STATUSES: readonly OrderStatus[] = ['pending', 'confirmed', 'on_hold'];
