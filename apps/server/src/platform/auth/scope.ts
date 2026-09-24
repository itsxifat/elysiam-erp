import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import {
  rowInScope,
  type Action,
  type ScopedRow,
  type ScopeFilter,
  type Subject,
} from '@elysium/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { map, type Observable } from 'rxjs';

/**
 * Row scope: `own` and `branch` made real on the request path (architecture §6).
 *
 * The guard can only ask CASL "may this caller read ApprovalRequest at all",
 * and for a scoped rule the answer is "yes, some of them". Which ones is a
 * question about rows, so it has to be answered where the rows are read — and
 * a question every handler must remember to ask is one some handler will not.
 * A branch manager reading every branch's approvals, with amounts, was exactly
 * that: the route was guarded and the query was not.
 *
 * So the scope is **mandatory**, not advisory:
 *
 * 1. The guard computes the caller's filter for the route's own declared
 *    (action, subject) and hangs it on the request. The handler does not get to
 *    choose which subject it is scoped against.
 * 2. A handler applies it with `scopeWhere()` for a query or `assertInScope()`
 *    for one row. Either marks the scope as applied.
 * 3. `ScopeInterceptor` refuses to send a response for a scoped caller whose
 *    handler applied nothing — a 500 rather than a leak. A caller with
 *    org-wide reach, and a `create`, have nothing to apply and pass straight
 *    through, so the check costs nothing on the common path.
 *
 * This is the pattern every module from M03 on copies. Map the table's columns
 * once, pass them to `scopeWhere`, done.
 */

interface ScopeState {
  readonly action: Action;
  readonly subject: Subject;
  readonly filter: ScopeFilter;
  applied: boolean;
}

const SCOPE_STATE = Symbol('elysium:scope');

type ScopedRequest = object & { [SCOPE_STATE]?: ScopeState };

/** Called by the guard once the route's ability has been granted. */
export function attachScope(
  request: object,
  action: Action,
  subject: Subject,
  filter: ScopeFilter,
): void {
  // Nothing to narrow when the caller reaches the whole org. A `create` is
  // *not* exempt (W6, D-061): a branch manager allowed to create in branch A
  // must not create in branch B, so the handler asserts the row it is about to
  // insert with `assertInScope` before writing it.
  const applied = filter.kind === 'all';
  (request as ScopedRequest)[SCOPE_STATE] = { action, subject, filter, applied };
}

function stateOf(request: object): ScopeState {
  const state = (request as ScopedRequest)[SCOPE_STATE];
  if (state === undefined) {
    // A handler asking for a scope on a route the guard never scoped: a public
    // or authenticated-only route, or a test that skipped the guard. Refusing
    // is the only safe answer — there is no filter to apply.
    throw new InternalServerErrorException('This route has no ability scope to apply.');
  }
  return state;
}

/** The columns that carry a table's scope fields. Omit any the table lacks. */
export interface ScopeColumns {
  readonly createdBy?: SQL;
  readonly assignedTo?: SQL;
  readonly branchId?: SQL;
}

/**
 * The WHERE fragment that limits a query to the caller's scope.
 *
 * `true` for an org-wide caller, `false` for one with no grant, otherwise the
 * OR of their conditions. A condition on a column the table did not map
 * throws: an `own` rule on a table with no `created_by` is a design error, and
 * quietly dropping the condition would widen `own` to `org`.
 */
export function scopeWhere(request: object, columns: ScopeColumns): SQL {
  const state = stateOf(request);
  state.applied = true;

  const { filter } = state;
  if (filter.kind === 'all') return sql`true`;
  if (filter.kind === 'none') return sql`false`;

  const clauses = filter.anyOf.map((condition) => {
    const column = columns[condition.field];
    if (column === undefined) {
      throw new InternalServerErrorException(
        `${state.subject} is scoped by ${condition.field}, but this query maps no column for it.`,
      );
    }
    if (condition.field === 'branchId') {
      // One bound parameter per id; the list is never empty (an empty branch
      // scope means the whole org and never reaches here).
      return sql`${column} in (${sql.join(
        condition.in.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`;
    }
    return sql`${column} = ${condition.equals}`;
  });

  return sql`(${sql.join(clauses, sql` or `)})`;
}

/**
 * Refuse one row that falls outside the caller's scope.
 *
 * 404 rather than 403, for the same reason RLS gives "not found" across orgs:
 * a row you may not see should be indistinguishable from one that does not
 * exist, or the error becomes an oracle.
 */
export function assertInScope(request: object, row: ScopedRow): void {
  const state = stateOf(request);
  state.applied = true;
  if (!rowInScope(state.filter, row)) throw new NotFoundException('Not found.');
}

/** The caller's filter, for a service that needs to reason about it. */
export function scopeOf(request: object): ScopeFilter {
  return stateOf(request).filter;
}

/**
 * The backstop fired. Its own class so the audit interceptor can tell it from
 * any other 500: for a mutation it fires *after* the handler committed, so the
 * write happened, and it must still leave an audit row saying so.
 */
export class ScopeNotAppliedError extends InternalServerErrorException {
  constructor(
    readonly action: Action,
    readonly subject: Subject,
  ) {
    super(`This route returned ${action}:${subject} without applying the caller's scope.`);
  }
}

/**
 * The backstop: a scoped caller's response is not sent unless the handler
 * applied the scope.
 *
 * Failing here is loud on purpose. The alternative failure — a list that
 * forgot its filter — returns more rows than it should, which looks exactly
 * like working, and nobody files a bug about seeing too much.
 */
@Injectable()
export class ScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<object>();

    return next.handle().pipe(
      map((body: unknown) => {
        const state = (request as ScopedRequest)[SCOPE_STATE];
        if (state !== undefined && !state.applied) {
          throw new ScopeNotAppliedError(state.action, state.subject);
        }
        return body;
      }),
    );
  }
}
