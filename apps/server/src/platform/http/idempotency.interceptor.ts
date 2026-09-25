import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { RequestContext } from '@elysium/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { firstValueFrom, from, type Observable } from 'rxjs';

import {
  checkKey,
  fingerprint,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IDEMPOTENCY_WINDOW_HOURS,
  isMutation,
  routeOf,
} from './idempotency.js';
import {
  claim,
  complete,
  release,
  type IdempotencyScope,
  type IdempotencyRecord,
} from './idempotency.store.js';

/**
 * `Idempotency-Key` on mutations (architecture §23).
 *
 * The problem is not theoretical. The order desk works over mobile data: a POST
 * goes out, the reply is lost, the operator taps again, and without this the
 * second tap posts a second journal or books a second parcel. §23 therefore says
 * mutations accept the header and the answer is kept for 24 hours per user and
 * route; this is the enforcement.
 *
 * **Registered outermost, ahead of the audit interceptor.** That order is
 * load-bearing in both directions. Going in, a replay short-circuits before
 * `AuditInterceptor` runs, so a replayed response does not write a second audit
 * row claiming a mutation that did not happen — the audit log would then show
 * two cash entries for one. Coming out, this interceptor is the *last* to see the
 * value, which means what it stores is what the serializer already stripped
 * (invariant 5): a replay cannot disclose more than the first answer did.
 *
 * The ability guard is unaffected, because Nest runs guards before interceptors.
 * A replay is authorized exactly like the original request, so a user whose role
 * was revoked in between does not get to replay their old answer.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly windowHours: number = IDEMPOTENCY_WINDOW_HOURS) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers[IDEMPOTENCY_HEADER];

    // Nothing to do for the overwhelming majority of requests, and this is the
    // hot path, so it is decided before anything touches the database.
    if (header === undefined || !isMutation(request.method)) return next.handle();

    const checked = checkKey(header);
    if (!checked.ok) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_INVALID', message: checked.why });
    }

    const requestContext = (request as FastifyRequest & { context?: RequestContext }).context;
    /*
     * No org, no record.
     *
     * The store is a tenant table under RLS (invariant 4), so a record needs an
     * org — and the only mutation that legitimately runs before an org is chosen
     * is `POST /v1/me/active-org`, which sets a value rather than appending one
     * and is therefore idempotent already. Failing the request instead would
     * refuse a client for sending a header §23 says it may send.
     */
    if (requestContext?.orgId == null) return next.handle();

    const scope: IdempotencyScope = {
      orgId: requestContext.orgId,
      userId: requestContext.userId,
      route: routeOf(request.method, routeTemplate(request)),
      key: checked.key,
    };

    // `from`, not `of`: `of(promise)` would emit the promise object itself, and
    // Nest unwraps a promise a handler returns but not one an interceptor emits.
    return from(this.run(context, next, request, scope));
  }

  private async run(
    context: ExecutionContext,
    next: CallHandler,
    request: FastifyRequest,
    scope: IdempotencyScope,
  ): Promise<unknown> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const print = fingerprint(request.method, request.url.split('?')[0] ?? '', request.body);

    const outcome = await claim(scope, print, this.windowHours);
    if (outcome.kind === 'existing') {
      return this.replay(reply, outcome.record, print);
    }

    let body: unknown;
    try {
      body = await firstValueFrom(next.handle());
    } catch (error) {
      // The attempt failed, so the key goes back: see `release` for why holding
      // it would turn a momentary failure into a day-long one.
      await release(scope);
      throw error;
    }

    /*
     * The mutation has already committed. Our bookkeeping must not undo that.
     *
     * If `complete()` throws — a momentary database failure, a serialization
     * error — the old code let it propagate, so the caller received an error for
     * a mutation that had succeeded *and* the key was left claimed but not
     * completed. Every retry then answered `IDEMPOTENCY_IN_FLIGHT` until the
     * 24-hour window expired: the client could neither learn that it worked nor
     * try again, for a day, because of a hiccup in the ledger of retries.
     *
     * So the response goes back regardless, and the failure is loud. The key
     * stays claimed rather than released, and that is deliberate: releasing it
     * would let a retry re-run a mutation that already happened, which on this
     * system means a second payment. A retry still gets `IN_FLIGHT`, which
     * refuses to act — the safe answer when we genuinely do not know what the
     * first attempt returned.
     */
    try {
      await complete(scope, statusOf(context, reply, request.method), body);
    } catch (error) {
      const request_ = context.switchToHttp().getRequest<FastifyRequest>();
      request_.log.error(
        { err: error, key: scope.key, route: scope.route },
        'idempotency record could not be completed; the mutation succeeded and the key stays claimed',
      );
    }

    return body;
  }

  /**
   * Answer from the record.
   *
   * Three cases, and conflating any two of them is a bug a client cannot work
   * around:
   *
   * - a *different* body under the same key is `IDEMPOTENCY_CONFLICT`, never a
   *   replay — replaying would hand the caller a receipt for a different
   *   payment than the one they just submitted;
   * - a key whose first request has not answered yet is `IDEMPOTENCY_IN_FLIGHT`,
   *   which is retryable in a moment, unlike the conflict above;
   * - otherwise the stored status and body, verbatim.
   */
  private replay(reply: FastifyReply, record: IdempotencyRecord, print: string): unknown {
    if (record.requestFingerprint !== print) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'That Idempotency-Key was already used for a different request.',
      });
    }

    if (record.completedAt === null || record.statusCode === null) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_FLIGHT',
        message: 'That request is still being processed. Retry in a moment.',
      });
    }

    void reply.status(record.statusCode).header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
    return record.responseBody;
  }
}

/**
 * The status the first attempt answered with.
 *
 * Read from the route's declaration rather than from `reply.statusCode`, because
 * at this point in the chain Nest has not applied it yet: it calls
 * `reply.status(...)` only after every interceptor has returned, so
 * `reply.statusCode` is still Fastify's default 200 and a POST's 201 would be
 * stored — and replayed — as a 200. A handler that set the status itself is
 * honoured, which is why a non-200 already on the reply wins.
 */
/** Fastify's default reply status, as a number: see `statusOf`. */
const FASTIFY_DEFAULT_STATUS = 200;

function statusOf(context: ExecutionContext, reply: FastifyReply, method: string): number {
  if (reply.statusCode !== FASTIFY_DEFAULT_STATUS) return reply.statusCode;

  const declared = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as unknown;
  if (typeof declared === 'number') return declared;

  return method.toUpperCase() === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
}

/**
 * The route pattern, e.g. `/v1/ledger/periods/close` or `/v1/orders/:id`.
 *
 * Fastify's own routing table, not the concrete url: §23 scopes the record per
 * *route*, and using the concrete path would make `PUT /v1/orders/7` and
 * `PUT /v1/orders/8` separate scopes that a single key could not collide inside
 * — which sounds harmless until you notice the fingerprint then becomes the only
 * thing distinguishing them, and a key meant for order 7 would be free to run
 * again against order 8.
 */
function routeTemplate(request: FastifyRequest): string {
  const options = (request as FastifyRequest & { routeOptions?: { url?: string } }).routeOptions;
  return options?.url ?? request.url.split('?')[0] ?? request.url;
}
