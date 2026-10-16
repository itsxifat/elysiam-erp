import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  TERMINAL_DEVICE_HEADER,
  labelSettingsSchema,
  printJobsQuerySchema,
  printRequestSchema,
  printerCreateSchema,
  printerUpdateSchema,
  readyForLabelQuerySchema,
  stationResultSchema,
} from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { PrintersService } from './printers.service.js';
import { PrintingService } from './printing.service.js';
import { terminalTokenOf } from './terminal-token.js';

const idSchema = z.string().uuid('No such record.');

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message:
        issue === undefined
          ? 'That is not valid.'
          : `${issue.path.join('.') || 'body'}: ${issue.message}`,
    });
  }
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

const tokenOf = (request: FastifyRequest) =>
  terminalTokenOf(request.headers[TERMINAL_DEVICE_HEADER]);

const NO_ROWS = 'printers and the auto-print rule are the hub’s, not an order’s (D-820)';

/**
 * Labels over HTTP (M46, D-810 to D-819).
 *
 * - The printers and the brand's auto-print rule: `read PackingTerminal` to see them, `create`
 *   and `update PackingTerminal` (the hub's supervisors) to change them and print a test page.
 * - Printing an order, the queue, the log and its CSV, retrying and cancelling: `update Order`,
 *   the hub's own grant (§6: the warehouse org-wide), with the caller's scope applied to every
 *   order before it is read or printed. The order page's print record is `read Order`.
 * - The browser print station: `update Order` at a computer bound to a label terminal (its
 *   `x-terminal-device` token), as a person assigned there.
 */
@Controller('v1/labels')
export class LabelsController {
  constructor(
    private readonly printing: PrintingService,
    private readonly printers: PrintersService,
  ) {}

  @RequireAbility('read', 'PackingTerminal')
  @Get('settings')
  async settings(@Req() request: FastifyRequest) {
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.printing.settings(requireContext(request));
  }

  @RequireAbility('update', 'PackingTerminal')
  @Put('settings')
  async saveSettings(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(labelSettingsSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.printing.saveSettings(requireContext(request), auditable(request), input);
  }

  @RequireAbility('read', 'PackingTerminal')
  @Get('printers')
  async listPrinters(@Req() request: FastifyRequest) {
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.printers.list(requireContext(request));
  }

  /** Add a printer. An IPPS password is sealed, never returned (D-814). */
  @RequireAbility('create', 'PackingTerminal')
  @Post('printers')
  async addPrinter(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(printerCreateSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.printers.create(requireContext(request), auditable(request), input);
  }

  @RequireAbility('update', 'PackingTerminal')
  @Put('printers/:id')
  async updatePrinter(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(printerUpdateSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.printers.update(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** Delete a printer from use; its prints stay in the log. */
  @RequireAbility('update', 'PackingTerminal')
  @Delete('printers/:id')
  async deletePrinter(@Req() request: FastifyRequest, @Param('id') id: string) {
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.printers.remove(requireContext(request), auditable(request), parse(idSchema, id));
  }

  /** A test page on this printer, through the queue like any print (D-815). */
  @RequireAbility('update', 'PackingTerminal')
  @Post('printers/:id/test')
  @HttpCode(200)
  async testPrint(@Req() request: FastifyRequest, @Param('id') id: string) {
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.printing.testPrint(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
    );
  }

  /** Orders with a consignment whose label has not printed (D-817). */
  @RequireAbility('update', 'Order')
  @Get('ready')
  async ready(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(readyForLabelQuerySchema, query ?? {});
    return this.printing.ready(requireContext(request), request, input);
  }

  /** Print orders' labels or slips now; a reprint needs a reason (D-818). */
  @RequireAbility('update', 'Order')
  @Post('print')
  @HttpCode(200)
  async print(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(printRequestSchema, body);
    return this.printing.print(
      requireContext(request),
      auditable(request),
      input,
      tokenOf(request),
    );
  }

  /** The queue (`view=queue`) or the whole log, newest first (D-818). */
  @RequireAbility('update', 'Order')
  @Get('jobs')
  async jobs(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(printJobsQuerySchema, query ?? {});
    return this.printing.jobs(requireContext(request), request, input);
  }

  /** The log as CSV, with the same filter (D-818). */
  @RequireAbility('update', 'Order')
  @Get('jobs/export')
  async exportJobs(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const input = parse(printJobsQuerySchema, query ?? {});
    const csv = await this.printing.exportCsv(requireContext(request), request, input);
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="print-log.csv"')
      .header('cache-control', 'no-store')
      .send(csv);
  }

  @RequireAbility('update', 'Order')
  @Post('jobs/:id/retry')
  @HttpCode(200)
  async retry(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.printing.retry(requireContext(request), auditable(request), parse(idSchema, id));
  }

  @RequireAbility('update', 'Order')
  @Post('jobs/:id/cancel')
  @HttpCode(200)
  async cancel(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.printing.cancel(requireContext(request), auditable(request), parse(idSchema, id));
  }

  /** One order's prints, lot by lot: how many times, when, by whom, where (D-818). */
  @RequireAbility('read', 'Order')
  @Get('orders/:orderId')
  async orderPrints(@Req() request: FastifyRequest, @Param('orderId') orderId: string) {
    return this.printing.orderPrints(requireContext(request), request, parse(idSchema, orderId));
  }

  /** The browser print station's waiting jobs (D-816). */
  @RequireAbility('update', 'Order')
  @Get('station/jobs')
  async stationJobs(@Req() request: FastifyRequest) {
    return this.printing.stationJobs(requireContext(request), request, tokenOf(request));
  }

  /** One job's PDF for the station to print; the job is then being sent. */
  @RequireAbility('update', 'Order')
  @Get('station/jobs/:id/document')
  async stationDocument(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const rendered = await this.printing.stationDocument(
      requireContext(request),
      request,
      tokenOf(request),
      parse(idSchema, id),
    );
    await reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${rendered.filename}"`)
      .header('x-print-copies', String(rendered.copies))
      .header('cache-control', 'no-store')
      .send(Buffer.from(rendered.bytes));
  }

  /** The station's word on a job: printed, or failed (the label team is told). */
  @RequireAbility('update', 'Order')
  @Post('station/jobs/:id/result')
  @HttpCode(200)
  async stationResult(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(stationResultSchema, body);
    return this.printing.stationResult(
      requireContext(request),
      auditable(request),
      tokenOf(request),
      parse(idSchema, id),
      input,
    );
  }
}
