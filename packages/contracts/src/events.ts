import { z } from 'zod';

import { MEMBERSHIP_ROLES, type MembershipRole } from './iam.js';

/**
 * The realtime event catalog (architecture §19).
 *
 * Every event that leaves this system has a schema here and nowhere else, and
 * each one carries **the rooms it may go to** beside its payload. That pairing
 * is the whole design:
 *
 * §19's rule is that the *server* decides rooms and clients never choose them.
 * A subscriber that could name its own audience could widen it, and widening it
 * is how one org's order count reaches another org's dashboard. Keeping the
 * audience in the contract means the emit helper can compute it, and a caller
 * cannot pass it.
 *
 * §19's other rule is about what a payload may contain: ids plus only the
 * display fields **every** recipient role is allowed to see — never cost, never
 * a full address. A socket has no `serializeFor` in front of it, so the schemas
 * here are the enforcement: each one is `.strict()`, so a field nobody thought
 * about is a validation error rather than a leak, and the emit helper parses
 * before it publishes. A payload that grew a `unitCostPoisha` would be refused
 * at the boundary instead of arriving in a reseller's browser.
 */

/** A room name. Computed by the server from the event and the actor's context. */
export type Room = string;

/**
 * Who an event is addressed to, resolved against one event's own data.
 *
 * Expressed as a function of the payload rather than as a literal list, because
 * most of §19's rooms depend on the row: `order.status_changed` goes to the
 * branch the order belongs to, `approval.decided` to the user who raised it.
 */
export interface EventAudience<TPayload> {
  /** Roles in the event's own org. `org:{orgId}:role:{role}`. */
  readonly roles?: readonly MembershipRole[];
  /** Extra rooms derived from the payload — a user, a branch, a reseller. */
  readonly extra?: (payload: TPayload) => readonly Room[];
  /** `super`, for the cross-org operations views (§19). */
  readonly superAdmin?: boolean;
}

export interface EventDefinition<TSchema extends z.ZodType> {
  readonly name: string;
  readonly schema: TSchema;
  readonly audience: EventAudience<z.infer<TSchema>>;
}

/**
 * One catalog entry, with its payload type carried through.
 *
 * A function rather than an object literal validated by `satisfies`, because
 * `satisfies Record<string, EventDefinition<z.ZodType>>` widens every `extra`
 * callback's argument to `unknown` — and an audience that cannot read its own
 * payload is an audience that has to guess which field holds the user id.
 */
function defineEvent<TSchema extends z.ZodType>(
  name: string,
  schema: TSchema,
  audience: EventAudience<z.infer<TSchema>>,
): EventDefinition<TSchema> {
  return { name, schema, audience };
}

/** `user:{id}` — the one room that is about a person rather than an org. */
export const userRoom = (userId: string): Room => `user:${userId}`;
export const branchRoom = (orgId: string, branchId: string): Room =>
  `org:${orgId}:branch:${branchId}`;
export const roleRoom = (orgId: string, role: MembershipRole): Room => `org:${orgId}:role:${role}`;
export const resellerRoom = (resellerId: string): Room => `reseller:${resellerId}`;
export const SUPER_ROOM: Room = 'super';

/**
 * Every room a caller is entitled to be in, from their context alone.
 *
 * This is the other half of "the server decides rooms": on connect the gateway
 * computes this and joins the socket to exactly these. A room that is not in
 * this set is one the socket can never receive, whatever an emitter asks for,
 * so an emit bug cannot become a cross-tenant leak on its own.
 */
export function roomsForContext(context: {
  readonly userId: string;
  readonly orgId: string | null;
  readonly roles: readonly MembershipRole[];
  readonly branchIds: readonly string[];
  readonly isSuperAdmin: boolean;
}): Room[] {
  const rooms: Room[] = [userRoom(context.userId)];

  if (context.orgId !== null) {
    for (const role of context.roles) rooms.push(roleRoom(context.orgId, role));
    for (const branchId of context.branchIds) rooms.push(branchRoom(context.orgId, branchId));
  }

  if (context.isSuperAdmin) rooms.push(SUPER_ROOM);
  return [...new Set(rooms)];
}

/*
 * The payloads.
 *
 * `.strict()` everywhere, and money as a decimal string when it appears at all
 * (invariant 1). Amounts are included only where §19's catalog lists them and
 * every recipient role may see them — an order total is shown to sales, so it
 * is here; a cost never is, for anyone, so there is no field for it to arrive
 * in.
 */
const poishaString = z.string().regex(/^-?\d+$/, 'Amounts are integer poisha as a string.');
const uuid = z.string().uuid();

export const approvalRequestedPayload = z
  .object({
    id: uuid,
    type: z.string(),
    /**
     * Null when the amount is a cost figure.
     *
     * A socket has no `serializeFor` in front of it, and §19 allows only the
     * fields **every** recipient role may see. This event goes to every role
     * that can check anything, which includes roles without `read:cost` — so a
     * stock write-off's value, which is WAC, is withheld at emit time rather
     * than filtered per recipient. `amountWithheld` says so explicitly, because
     * a null that might mean "no amount" or might mean "not for you" is a null
     * a UI has to guess about.
     */
    amountPoisha: poishaString.nullable(),
    amountWithheld: z.boolean().optional(),
    required: z.boolean(),
    /** `pending` or `auto_approved` — below the threshold it is already done. */
    status: z.string(),
  })
  .strict();

export const approvalDecidedPayload = z
  .object({
    id: uuid,
    /*
     * `auto_approved` is one of these, and leaving it out would have been a
     * silent drop rather than an error: a request under its org's threshold is
     * decided the moment it is raised, and the requester still needs to be told
     * so. The database enum has the same five values; `cancelled` is a request its
     * owning module withdrew (gaps-users-auth), which the requester hears about too.
     */
    decision: z.enum(['approved', 'rejected', 'auto_approved', 'cancelled']),
    requestedBy: z.string(),
  })
  .strict();

export const jobFailedPayload = z
  .object({
    queue: z.string(),
    /** The row the job was about, when it had one. Never the payload itself. */
    ref: z.string().nullable(),
    code: z.string(),
  })
  .strict();

export const walletBalanceChangedPayload = z
  .object({
    accountId: uuid,
    branchId: uuid.nullable(),
    balancePoisha: poishaString,
  })
  .strict();

export const ledgerPostedPayload = z
  .object({
    journalId: uuid,
    sourceType: z.string(),
    businessDate: z.string(),
  })
  .strict();

/**
 * §19: sku id, location, available, reorder level. No cost and no value.
 *
 * The audience is `org_admin` and `warehouse`, which is what forces the payload
 * to be quantities only: a socket has no `serializeFor` in front of it and
 * `warehouse` does not hold `read:cost`, so a `stockValuePoisha` here would
 * arrive in a packer's browser. Availability is the number that answers "reorder
 * now or not", and it is already the useful one.
 */
export const stockLowPayload = z
  .object({
    skuId: uuid,
    skuCode: z.string(),
    locationId: uuid,
    available: z.number().int(),
    reorderLevel: z.number().int(),
  })
  .strict();

/**
 * The nightly reconciliation found levels that disagree with Σ movements (§8, §26).
 *
 * Counts only, never the drifting quantities themselves: this goes to `org_admin`
 * and to the super-admin operations view, and a drift is investigated by opening
 * the reconciliation row rather than by reading a socket payload. Keeping the
 * detail out means the event cannot grow into a stock report that bypasses
 * permissions (D-144).
 */
export const stockDriftDetectedPayload = z
  .object({
    reconciliationId: uuid,
    businessDate: z.string(),
    levelsChecked: z.number().int(),
    driftCount: z.number().int(),
    costDriftCount: z.number().int(),
  })
  .strict();

/**
 * §19: id, order_no, channel, total, created_at. The total and nothing near a cost.
 *
 * The audience is sales and org_admin, both of which see an order's value on the screen
 * anyway, so the order total belongs here — it is what makes the new-order alert worth
 * looking at. A socket has no `serializeFor` in front of it, so there is no cost field
 * for one to arrive in, and `codAmountPoisha` is the figure the desk actually works
 * from: what the rider will collect.
 */
export const orderCreatedPayload = z
  .object({
    id: uuid,
    orderNo: z.string(),
    channel: z.string(),
    codAmountPoisha: poishaString,
    /** Null while the order sits in §6's unassigned queue. */
    assignedTo: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

/**
 * §19: id, assignee. Queue ownership, and nothing else.
 *
 * Two events share this schema — `order.assigned` when a supervisor hands the order over,
 * `order.claimed` when an agent takes it out of the queue themselves — because the
 * payload is identical and the distinction is who acted. Keeping them as separate names
 * lets the desk show "assigned to you" differently from "you took this", which is the
 * only reason anybody cares.
 */
export const orderAssignedPayload = z
  .object({ id: uuid, orderNo: z.string(), assignedTo: z.string() })
  .strict();

/**
 * M35b: an order's lines, money or address were changed at the desk (or by a server). Id,
 * number and when, nothing more, for the same reason as the status change below; a screen
 * that needs the new figures fetches them. The marketplace sends ncom.bd the order as it now
 * stands when one of its orders is edited here (D-556).
 */
export const orderEditedPayload = z
  .object({ id: uuid, orderNo: z.string(), at: z.string() })
  .strict();

/**
 * §19: id, from, to, at.
 *
 * No amount at all, deliberately. This event drives live lists and dashboards for sales,
 * warehouse, accounts, a reseller and a branch — the widest audience in the catalog — and
 * the one payload every one of those roles may see is the status change itself. Anything
 * a screen needs beyond that it fetches, where `serializeFor` applies.
 */
export const orderStatusChangedPayload = z
  .object({
    id: uuid,
    orderNo: z.string(),
    /** Null on the row that records the order being created. */
    from: z.string().nullable(),
    to: z.string(),
    at: z.string(),
    /** Set for a reseller order, so the portal room can be addressed (§13). */
    resellerId: uuid.nullable(),
    /** Set for a branch-owned order, so the branch room can be addressed (§14). */
    branchId: uuid.nullable(),
  })
  .strict();

/**
 * The catalog, as data.
 *
 * Only the events something already emits are here. §19 lists twenty-odd, and
 * the rest arrive with the milestone that raises them — a schema for an event
 * nobody publishes is a guess about a payload, and the guess is what later
 * turns into a field nobody meant to send.
 */
/**
 * A parcel the courier refused after every retry (§19, §20; M12 check 6).
 *
 * No amount: a booking that failed has no money in it yet, and the COD would be the one
 * number a reader could act on wrongly. No courier error text either — a courier's refusal
 * body quotes the recipient's name, address and phone number, and a socket has no
 * `serializeFor` in front of it (invariant 10). A code and the ids, so the desk can open
 * the order and see why nothing is moving.
 */
export const deliveryBookingFailedPayload = z
  .object({
    orderId: uuid,
    orderNo: z.string(),
    consignmentId: uuid,
    courierId: uuid,
    code: z.string(),
    attempts: z.number().int(),
  })
  .strict();

/**
 * §19: target id, achieved, pct — a progress widget moved (M20).
 *
 * To the employees the target counts (`user:{id}` for each) and to HR. `achieved` is in
 * the target's own unit — orders, or poisha for a revenue target — as an integer string,
 * and both audiences may see it: it is the employee's own figure, and HR set the target.
 * `userIds` is here only so the audience can address the members' own rooms; it is a list
 * of login ids, which every recipient already knows or may know.
 */
export const targetProgressPayload = z
  .object({
    targetId: uuid,
    achieved: z.string().regex(/^\d+$/, 'An achieved figure is a non-negative integer string.'),
    /** Achieved over target in basis points, rounded down: 10,000 is 100%. */
    pctBps: z.number().int().min(0),
    userIds: z.array(z.string().min(1)).max(50),
  })
  .strict();

/**
 * A company loan instalment is coming due, or is overdue and nobody was told (M26, §15).
 *
 * The in-app half of a loan reminder; the SMS half goes through the notify module. Once per
 * instalment: the reminder row that causes it is unique per instalment. The amount is the
 * instalment's, which every recipient — accounts and org_admin, the two roles holding
 * `CompanyLoan` — already sees on the loan's statement. No lender name: the console
 * fetches the loan.
 */
export const loanInstalmentDuePayload = z
  .object({
    loanId: uuid,
    instalmentId: uuid,
    seq: z.number().int(),
    dueOn: z.string(),
    amountPoisha: poishaString,
  })
  .strict();

export const EVENTS = {
  'approval.requested': defineEvent('approval.requested', approvalRequestedPayload, {
    // §19: to every eligible checker. The dispatcher narrows that from
    // CHECKER_TYPES; these are the roles that can check anything at all.
    roles: ['org_admin', 'accounts', 'hr', 'branch_manager'],
  }),
  'approval.decided': defineEvent('approval.decided', approvalDecidedPayload, {
    extra: (payload) => [userRoom(payload.requestedBy)],
  }),
  'job.failed': defineEvent('job.failed', jobFailedPayload, {
    roles: ['org_admin'],
    superAdmin: true,
  }),
  'wallet.balance_changed': defineEvent('wallet.balance_changed', walletBalanceChangedPayload, {
    roles: ['accounts'],
    extra: (payload) => (payload.branchId === null ? [] : [`branch:${payload.branchId}`]),
  }),
  'ledger.posted': defineEvent('ledger.posted', ledgerPostedPayload, {
    roles: ['accounts', 'org_admin'],
  }),
  // M07's stock events (§19). `stock.available_changed` belongs with the order
  // desk that makes availability move minute to minute, and §19 marks it
  // throttled; a catalogue entry for an event nothing emits is a guess about a
  // payload, so it arrives with M11.
  'stock.low': defineEvent('stock.low', stockLowPayload, {
    roles: ['org_admin', 'warehouse'],
  }),
  'stock.drift_detected': defineEvent('stock.drift_detected', stockDriftDetectedPayload, {
    roles: ['org_admin'],
    superAdmin: true,
  }),
  // M10's order events (§19).
  'order.created': defineEvent('order.created', orderCreatedPayload, {
    roles: ['sales', 'org_admin'],
  }),
  'order.assigned': defineEvent('order.assigned', orderAssignedPayload, {
    roles: ['sales'],
    extra: (payload) => [userRoom(payload.assignedTo)],
  }),
  'order.claimed': defineEvent('order.claimed', orderAssignedPayload, {
    roles: ['sales'],
    extra: (payload) => [userRoom(payload.assignedTo)],
  }),
  'order.status_changed': defineEvent('order.status_changed', orderStatusChangedPayload, {
    roles: ['sales', 'warehouse'],
    extra: (payload) => [
      // §19 gives accounts delivered and returned only: those are the two that move the
      // books, and the rest are warehouse and desk traffic they have no use for.
      ...(['delivered', 'partially_delivered', 'returned'].includes(payload.to)
        ? ['role:accounts']
        : []),
      ...(payload.resellerId === null ? [] : [resellerRoom(payload.resellerId)]),
      ...(payload.branchId === null ? [] : [`branch:${payload.branchId}`]),
    ],
  }),
  'order.edited': defineEvent('order.edited', orderEditedPayload, {
    roles: ['sales', 'warehouse'],
  }),
  'delivery.booking_failed': defineEvent('delivery.booking_failed', deliveryBookingFailedPayload, {
    roles: ['org_admin'],
    superAdmin: true,
  }),
  // M20. §19: `user:{employee}` and `org:role:hr`.
  'target.progress': defineEvent('target.progress', targetProgressPayload, {
    roles: ['hr'],
    extra: (payload) => payload.userIds.map(userRoom),
  }),
  // M26's loan reminder (§15): the two roles that hold `CompanyLoan`.
  'loan.instalment_due': defineEvent('loan.instalment_due', loanInstalmentDuePayload, {
    roles: ['accounts', 'org_admin'],
  }),
} as const;

export type EventName = keyof typeof EVENTS;

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

export type EventPayload<TName extends EventName> = z.infer<(typeof EVENTS)[TName]['schema']>;

/**
 * Validate a payload against its own schema, or refuse to publish it.
 *
 * Called by the emit helper before anything reaches a socket or the outbox, so
 * §19's payload rule is enforced at one point rather than trusted at twenty
 * call sites. The error names the event, because a Zod message alone does not
 * say which emitter produced it.
 */
export function parseEventPayload<TName extends EventName>(
  name: TName,
  payload: unknown,
): EventPayload<TName> {
  const definition = EVENTS[name];
  const parsed = definition.schema.safeParse(payload);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`event ${name} has an invalid payload — ${detail}`);
  }

  return parsed.data as EventPayload<TName>;
}

/**
 * The rooms one event instance goes to.
 *
 * `orgId` is the event's org, not the actor's: an event is addressed to the
 * tenant it happened in. A room for another org cannot be produced here, which
 * is the property that makes the gateway's own room check a second lock rather
 * than the only one.
 */
export function roomsForEvent<TName extends EventName>(
  name: TName,
  orgId: string,
  payload: EventPayload<TName>,
): Room[] {
  const audience = EVENTS[name].audience as EventAudience<unknown>;
  const rooms: Room[] = [];

  for (const role of audience.roles ?? []) rooms.push(roleRoom(orgId, role));
  if (audience.superAdmin === true) rooms.push(SUPER_ROOM);

  for (const room of audience.extra?.(payload) ?? []) {
    /*
     * A payload-derived branch room is written `branch:{id}` by the audience and
     * qualified with the org here, so an event cannot name another tenant's branch room
     * even by accident. `role:{name}` works the same way, and M10 needed it: §19 sends
     * `order.status_changed` to accounts for *delivered and returned only*, which is a
     * decision about the payload and therefore cannot be expressed in the static
     * `roles` list. Both prefixes are qualified here rather than by the audience, so a
     * room for another tenant remains unconstructable.
     */
    rooms.push(
      room.startsWith('branch:') || room.startsWith('role:') ? `org:${orgId}:${room}` : room,
    );
  }

  return [...new Set(rooms)];
}

/** Every role name is a real one — a typo'd audience is an empty audience. */
export function auditEventCatalog(): string[] {
  const problems: string[] = [];

  for (const [name, entry] of Object.entries(EVENTS)) {
    const definition = entry as EventDefinition<z.ZodType>;
    for (const role of definition.audience.roles ?? []) {
      if (!MEMBERSHIP_ROLES.includes(role)) {
        problems.push(`${name} names unknown role ${String(role)}`);
      }
    }
    if (definition.name !== name) {
      problems.push(`${name} carries the name ${definition.name}`);
    }
  }

  return problems;
}
