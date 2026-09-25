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
     * so. The database enum has the same five values.
     */
    decision: z.enum(['approved', 'rejected', 'auto_approved']),
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
 * The catalog, as data.
 *
 * Only the events something already emits are here. §19 lists twenty-odd, and
 * the rest arrive with the milestone that raises them — a schema for an event
 * nobody publishes is a guess about a payload, and the guess is what later
 * turns into a field nobody meant to send.
 */
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
    // A payload-derived branch room is written `branch:{id}` by the audience
    // and qualified with the org here, so an event cannot name another
    // tenant's branch room even by accident.
    rooms.push(room.startsWith('branch:') ? `org:${orgId}:${room}` : room);
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
