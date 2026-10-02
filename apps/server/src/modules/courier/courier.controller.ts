import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { Public, RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CourierAccountsService } from './accounts.service.js';
import { BookingService } from './booking.service.js';
import { courierHttpError, mapCourierErrors } from './courier.errors.js';
import { CourierLabelsService } from './labels.service.js';
import { CourierReportsService } from './reports.service.js';
import { ReturnsService } from './returns.service.js';
import { CourierSelectionService } from './selection.service.js';
import { SettlementsService } from './settlements.service.js';
import { StuckParcelsService } from './stuck.service.js';
import { CourierSyncService } from './sync.service.js';
import {
  bookParcelSchema,
  bulkBookSchema,
  confirmHandoverSchema,
  consignmentIdParamSchema,
  escalationSchema,
  fetchSettlementsSchema,
  importSettlementSchema,
  labelsQuerySchema,
  manualStatusSchema,
  parcelListSchema,
  performanceQuerySchema,
  receiveReturnSchema,
  reconciliationQuerySchema,
  rejectSettlementSchema,
  replaceSelectionRulesSchema,
  repollSchema,
  requestSettlementApprovalSchema,
  selectionPreviewSchema,
  settlementIdParamSchema,
  settlementListSchema,
  stuckQuerySchema,
  upsertCourierAccountSchema,
} from './courier.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Couriers over HTTP (architecture §9, §23; §6's matrix).
 *
 * Which ability each route declares is the milestone's role matrix, and it is worth reading
 * as a list:
 *
 * - **Setting up a courier account** is `update CourierSettlement`. §6 gives that to
 *   org_admin and accounts at `org`, which is the right pair: a courier account decides
 *   where a brand's COD lands, and that is a finance decision. There is deliberately no
 *   route that *reads back* a credential — the account view returns a fingerprint.
 * - **Booking, handover and a manual status** are `update Order`. They are order operations
 *   that happen to involve a courier, and §6 gives `Order` to sales (own), warehouse and
 *   org_admin — the people who actually hand boxes to riders.
 * - **Receiving a return** is `update Order` as well, and its stock effects are the
 *   warehouse's: §9 gives `→ returned` to "warehouse receives and inspects".
 * - **Settlements** are `read`/`create`/`update CourierSettlement`: §6 gives accounts all
 *   three and org_admin read and update. Nothing here posts one — `POST .../approval`
 *   *requests* it, and the posting happens in this module's approvals executor inside the
 *   transaction that decides `POST /v1/approvals/:id/decide` (D-088).
 * - **The COD reconciliation report** is `read LedgerReport`, like every other report, so a
 *   branch manager gets their branch's rows through the same row scope.
 *
 * ## The one public route
 *
 * `POST /v1/courier/webhooks/:orgId/:provider` is `@Public`, because a courier has no session
 * — and it is the only unauthenticated route in this module. Its authenticity comes from the
 * shared secret the account was set up with, compared in constant time; the org id in the
 * path is routing, not authentication. Nothing is stored until the secret verifies, so a
 * caller who guesses an org id can write nothing.
 */
@Controller('v1/courier')
export class CourierController {
  constructor(
    private readonly accounts: CourierAccountsService,
    private readonly booking: BookingService,
    private readonly sync: CourierSyncService,
    private readonly returns: ReturnsService,
    private readonly settlements: SettlementsService,
    private readonly reports: CourierReportsService,
    private readonly stuck: StuckParcelsService,
    private readonly selection: CourierSelectionService,
    private readonly labels: CourierLabelsService,
  ) {}

  // --- accounts -----------------------------------------------------------------

  @RequireAbility('read', 'CourierSettlement')
  @Get('accounts')
  async listAccounts(@Req() request: FastifyRequest) {
    return mapCourierErrors(() =>
      this.accounts.list(requireContext(request), { includeInactive: true }),
    );
  }

  /**
   * The adapters an account can use, with the credential field names each needs (D-395).
   * `read CourierSettlement`, like the accounts: the screen that sets one up is the reader.
   */
  @RequireAbility('read', 'CourierSettlement')
  @Get('providers')
  providers() {
    return this.accounts.providers();
  }

  @RequireAbility('update', 'CourierSettlement')
  @Post('accounts')
  async upsertAccount(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(upsertCourierAccountSchema, body);
    return mapCourierErrors(() =>
      this.accounts.upsert(requireContext(request), auditable(request), input),
    );
  }

  // --- parcels ------------------------------------------------------------------

  @RequireAbility('update', 'Order')
  @Post('parcels')
  async book(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(bookParcelSchema, body);
    return mapCourierErrors(() =>
      this.booking.bookFromDesk(requireContext(request), auditable(request), {
        orderId: input.orderId,
        courierId: input.courierId,
      }),
    );
  }

  /**
   * Many orders booked at once (M15). `update Order`, like the single booking: one
   * transaction per order, each scope-checked, and the answer lists every order's outcome.
   */
  @RequireAbility('update', 'Order')
  @Post('parcels/bulk')
  async bookMany(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(bulkBookSchema, body);
    return mapCourierErrors(() =>
      this.booking.bookMany(requireContext(request), auditable(request), {
        orderIds: input.orderIds,
        courierId: input.courierId,
      }),
    );
  }

  /** The console's parcel list (M15), newest first, in the caller's row scope. */
  @RequireAbility('read', 'Order')
  @Get('parcels')
  async parcels(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(parcelListSchema, query ?? {});
    return mapCourierErrors(() =>
      this.sync.listParcels(requireContext(request), request, {
        q: filter.q,
        status: filter.status,
        bookingState: filter.bookingState,
        courierId: filter.courierId,
        orderId: filter.orderId,
        awaitingReturn:
          filter.awaitingReturn === undefined ? undefined : filter.awaitingReturn === 'true',
        page: filter.page,
        pageSize: filter.pageSize,
      }),
    );
  }

  /**
   * Courier labels as a PDF (M15, through M04's Gotenberg slice).
   *
   * A `GET` with the ids in the query — rendering changes nothing — and `@Res()` because the
   * answer is bytes, so `SerializeInterceptor` never sees it. That is safe for the reason the
   * order documents give: `CourierLabelsService.gather` applies the caller's §6 scope before
   * any address is read, and the page carries no price and no cost.
   */
  @RequireAbility('read', 'Order')
  @Get('labels')
  async printLabels(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const input = parse(labelsQuerySchema, query ?? {});
    const rendered = await mapCourierErrors(() =>
      this.labels.render(requireContext(request), request, input.ids),
    );
    await reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${rendered.filename}"`)
      .send(Buffer.from(rendered.bytes));
  }

  /**
   * Which courier booking this order now would use, and why (M15's selection rules). A `GET`:
   * it decides and writes nothing.
   */
  @RequireAbility('read', 'Order')
  @Get('selection/preview')
  async previewSelection(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(selectionPreviewSchema, query ?? {});
    return mapCourierErrors(() =>
      this.selection.preview(requireContext(request), request, {
        orderId: input.orderId,
        courierId: input.courierId,
      }),
    );
  }

  /** The org's zone → courier rules. `read CourierSettlement`, like the accounts they route to. */
  @RequireAbility('read', 'CourierSettlement')
  @Get('selection-rules')
  async selectionRules(@Req() request: FastifyRequest) {
    return mapCourierErrors(() => this.selection.list(requireContext(request)));
  }

  /**
   * Replace the rule set. `update CourierSettlement`: which courier holds a brand's COD is the
   * same finance decision as setting up the courier's account (§6).
   */
  @RequireAbility('update', 'CourierSettlement')
  @Put('selection-rules')
  async replaceSelectionRules(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(replaceSelectionRulesSchema, body);
    return mapCourierErrors(() =>
      this.selection.replace(requireContext(request), auditable(request), input),
    );
  }

  // --- the stuck-parcel queue (M15) ---------------------------------------------

  @RequireAbility('read', 'Order')
  @Get('stuck')
  async stuckParcels(@Req() request: FastifyRequest, @Query() query: unknown) {
    const options = parse(stuckQuerySchema, query ?? {});
    return mapCourierErrors(() =>
      this.stuck.list(requireContext(request), request, {
        thresholdDays: options.thresholdDays,
        courierId: options.courierId,
      }),
    );
  }

  /** The queue as a CSV for the courier's support desk. No recipient details in it. */
  @RequireAbility('read', 'Order')
  @Get('stuck/export')
  async exportStuckParcels(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const options = parse(stuckQuerySchema, query ?? {});
    const file = await mapCourierErrors(() =>
      this.stuck.exportCsv(requireContext(request), request, {
        thresholdDays: options.thresholdDays,
        courierId: options.courierId,
      }),
    );
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .send(file.csv);
  }

  /** Ask the courier about these parcels again, now. The calls happen in the worker. */
  @RequireAbility('update', 'Order')
  @Post('stuck/repoll')
  async repoll(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(repollSchema, body);
    return mapCourierErrors(() =>
      this.stuck.requestRepoll(requireContext(request), auditable(request), input),
    );
  }

  /** Add a note to a parcel's escalation trail (append-only). */
  @RequireAbility('update', 'Order')
  @Post('parcels/:id/escalations')
  async escalate(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const consignmentId = parse(consignmentIdParamSchema, id);
    const input = parse(escalationSchema, body);
    return mapCourierErrors(() =>
      this.stuck.escalate(requireContext(request), auditable(request), consignmentId, input),
    );
  }

  /** The tracking timeline (M12's "tracking timeline on the order detail"). */
  @RequireAbility('read', 'Order')
  @Get('parcels/:id')
  async parcel(@Req() request: FastifyRequest, @Param('id') id: string) {
    const consignmentId = parse(consignmentIdParamSchema, id);
    return mapCourierErrors(() =>
      this.sync.timeline(requireContext(request), request, consignmentId),
    );
  }

  @RequireAbility('update', 'Order')
  @Post('parcels/:id/handover')
  async handover(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const consignmentId = parse(consignmentIdParamSchema, id);
    const input = parse(confirmHandoverSchema, body ?? {});
    return mapCourierErrors(() =>
      this.sync.confirmHandover(requireContext(request), auditable(request), consignmentId, input),
    );
  }

  /** §9's fallback: staff set a status the courier sync has not delivered yet. */
  @RequireAbility('update', 'Order')
  @Post('parcels/:id/status')
  async setStatus(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const consignmentId = parse(consignmentIdParamSchema, id);
    const input = parse(manualStatusSchema, body);
    return mapCourierErrors(() =>
      this.sync.setStatusManually(
        requireContext(request),
        auditable(request),
        consignmentId,
        input,
      ),
    );
  }

  // --- returns ------------------------------------------------------------------

  @RequireAbility('read', 'Order')
  @Get('parcels/:id/returnable')
  async returnable(@Req() request: FastifyRequest, @Param('id') id: string) {
    const consignmentId = parse(consignmentIdParamSchema, id);
    return mapCourierErrors(() =>
      this.returns.inspectable(requireContext(request), request, consignmentId),
    );
  }

  @RequireAbility('update', 'Order')
  @Post('parcels/:id/receive-return')
  async receiveReturn(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const consignmentId = parse(consignmentIdParamSchema, id);
    const input = parse(receiveReturnSchema, body);
    return mapCourierErrors(() =>
      this.returns.receive(requireContext(request), auditable(request), consignmentId, input),
    );
  }

  // --- settlements --------------------------------------------------------------

  @RequireAbility('read', 'CourierSettlement')
  @Get('settlements')
  async listSettlements(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(settlementListSchema.partial(), query ?? {});
    return mapCourierErrors(() =>
      this.settlements.list(requireContext(request), {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.courierId === undefined ? {} : { courierId: filter.courierId }),
      }),
    );
  }

  /**
   * Queue a fetch of this courier's statements from its API (M15). Refused, with the reason,
   * for a courier whose adapter has no settlement API — today, every real one.
   */
  @RequireAbility('create', 'CourierSettlement')
  @Post('settlements/fetch')
  async fetchSettlements(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(fetchSettlementsSchema, body);
    return mapCourierErrors(() =>
      this.settlements.requestFetch(requireContext(request), auditable(request), input),
    );
  }

  /** What the unattended fetch saw and did, statement by statement. */
  @RequireAbility('read', 'CourierSettlement')
  @Get('settlements/fetch-runs')
  async fetchRuns(@Req() request: FastifyRequest) {
    return mapCourierErrors(() => this.settlements.fetchRuns(requireContext(request)));
  }

  @RequireAbility('read', 'CourierSettlement')
  @Get('settlements/:id')
  async settlement(@Req() request: FastifyRequest, @Param('id') id: string) {
    const settlementId = parse(settlementIdParamSchema, id);
    return mapCourierErrors(() => this.settlements.get(requireContext(request), settlementId));
  }

  /** §9's exceptions report, on its own, because it is the screen somebody works from. */
  @RequireAbility('read', 'CourierSettlement')
  @Get('settlements/:id/exceptions')
  async exceptions(@Req() request: FastifyRequest, @Param('id') id: string) {
    const settlementId = parse(settlementIdParamSchema, id);
    return mapCourierErrors(() =>
      this.settlements.get(requireContext(request), settlementId, { exceptionsOnly: true }),
    );
  }

  @RequireAbility('create', 'CourierSettlement')
  @Post('settlements')
  async importSettlement(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(importSettlementSchema, body);
    return mapCourierErrors(() =>
      this.settlements.import(requireContext(request), auditable(request), input),
    );
  }

  /**
   * Ask for the posting to be approved (§9: "→ approval → posting").
   *
   * `update CourierSettlement`, not `approve`: this is the *maker* half. The checker decides
   * through `POST /v1/approvals/:id/decide`, which runs this module's executor in the same
   * transaction — so there is no route here that posts a settlement, and none that approves
   * one (D-088).
   */
  @RequireAbility('update', 'CourierSettlement')
  @Post('settlements/:id/approval')
  async requestApproval(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const settlementId = parse(settlementIdParamSchema, id);
    const input = parse(requestSettlementApprovalSchema, body ?? {});
    return mapCourierErrors(() =>
      this.settlements.requestApproval(
        requireContext(request),
        auditable(request),
        settlementId,
        input,
      ),
    );
  }

  @RequireAbility('update', 'CourierSettlement')
  @Post('settlements/:id/reject')
  async rejectSettlement(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const settlementId = parse(settlementIdParamSchema, id);
    const input = parse(rejectSettlementSchema, body);
    return mapCourierErrors(() =>
      this.settlements.reject(requireContext(request), auditable(request), settlementId, input),
    );
  }

  // --- reports ------------------------------------------------------------------

  @RequireAbility('read', 'LedgerReport')
  @Get('reports/cod-reconciliation')
  async reconciliation(@Req() request: FastifyRequest, @Query() query: unknown) {
    const options = parse(reconciliationQuerySchema.partial(), query ?? {});
    return mapCourierErrors(() =>
      this.reports.reconciliation(requireContext(request), request, {
        asOf: options.asOf,
        courierId: options.courierId,
      }),
    );
  }

  /** Delivery rate, average days and return rate, by courier and zone (M15). */
  @RequireAbility('read', 'LedgerReport')
  @Get('reports/performance')
  async performance(@Req() request: FastifyRequest, @Query() query: unknown) {
    const options = parse(performanceQuerySchema, query ?? {});
    return mapCourierErrors(() =>
      this.reports.performance(requireContext(request), request, {
        from: options.from,
        to: options.to,
        courierId: options.courierId,
      }),
    );
  }

  // --- the webhook --------------------------------------------------------------

  /**
   * A courier's status webhook (§9).
   *
   * Public because a courier has no session. Authenticity is the shared secret the account
   * was set up with, verified by the adapter in constant time; the org id in the path is
   * routing. A failed verification answers 401 and stores nothing, so a caller who guesses
   * an org id can write nothing into that tenant's data.
   *
   * The body is read as raw bytes rather than the parsed JSON Fastify would hand over,
   * because the stored `body_hash` — which is what recognises a retransmission — has to be
   * over exactly what arrived: a hash of a re-serialised object changes the day a library
   * reorders keys, and every stored webhook would then be stored a second time.
   */
  @Public(
    'A courier has no session; the shared secret on the request is what authenticates it (§9).',
  )
  @Post('webhooks/:orgId/:provider')
  async webhook(
    @Req() request: FastifyRequest,
    @Param('orgId') orgId: string,
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | undefined>,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw =
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody ??
      Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}), 'utf8');

    /*
     * The org id is validated before it reaches anything that would cast it.
     *
     * This is the only unauthenticated route in the module, and an unparsed path segment
     * reaches a uuid cast — so `/v1/courier/webhooks/nonsense/fake` was a 500 anyone on the
     * internet could produce. The refusal is the *same* 401 a wrong secret gets, because a
     * public endpoint that distinguishes "malformed org" from "wrong secret" is an endpoint
     * that helps an attacker find the shape of a real request.
     */
    if (!z.string().uuid().safeParse(orgId).success) {
      throw courierHttpError('WEBHOOK_SIGNATURE_INVALID', 'That webhook was not accepted.');
    }

    return mapCourierErrors(async () => {
      const result = await this.sync.acceptWebhook({
        orgId,
        providerCode: provider,
        headers,
        raw,
      });
      /*
       * The courier's required answer, when it has one (M15). Pathao's merchant panel only
       * registers a callback URL that answers 202 with its integration header, so the status
       * and header come from the adapter rather than being Nest's default 201 — which every
       * courier that only needs a 2xx still gets.
       */
      if (result.acknowledgement !== null) {
        void reply.status(result.acknowledgement.status);
        for (const [name, value] of Object.entries(result.acknowledgement.headers)) {
          void reply.header(name, value);
        }
      }
      // A 2xx for a retransmission too. A courier that gets an error for re-sending a body it
      // already sent will send it again, sooner.
      return { accepted: result.accepted, duplicate: result.duplicate };
    });
  }
}
