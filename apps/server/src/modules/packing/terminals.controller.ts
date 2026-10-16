import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  TERMINAL_DEVICE_HEADER,
  terminalBindSchema,
  terminalCamerasSchema,
  terminalCreateSchema,
  terminalMembersSchema,
  terminalUpdateSchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  auditNothingChanged,
  type AuditableRequest,
} from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { terminalTokenOf } from './terminal-token.js';
import { TerminalsService } from './terminals.service.js';

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

const NO_ROWS = 'a terminal is the hub’s, not an order’s or a branch’s (D-820)';

/**
 * The hub's terminals over HTTP (M46, D-801 to D-803, D-820). `read PackingTerminal` to see them
 * (org_admin, branch_manager, warehouse) and to check a bound computer in; `create` and `update
 * PackingTerminal` (org_admin, branch_manager) to set them up, assign people and cameras, and
 * bind or unbind a computer. A terminal has no row dimension: it is the hub's.
 */
@Controller('v1/terminals')
export class TerminalsController {
  constructor(private readonly terminals: TerminalsService) {}

  @RequireAbility('read', 'PackingTerminal')
  @Get()
  async list(@Req() request: FastifyRequest) {
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.terminals.list(requireContext(request));
  }

  @RequireAbility('create', 'PackingTerminal')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(terminalCreateSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.terminals.create(requireContext(request), auditable(request), input);
  }

  /**
   * A bound computer's check-in (D-803): every half minute from Labels and Packaging. Moves only
   * the binding's last-seen instant and who is signed in there; nothing a supervisor audits.
   */
  @RequireAbility('read', 'PackingTerminal')
  @Post('check-in')
  @HttpCode(200)
  async checkIn(@Req() request: FastifyRequest) {
    scopeHasNoRowDimension(request, NO_ROWS);
    auditNothingChanged(
      auditable(request),
      'a check-in moves only the computer’s last-seen instant and who is signed in there',
    );
    return this.terminals.checkIn(
      requireContext(request),
      terminalTokenOf(request.headers[TERMINAL_DEVICE_HEADER]),
    );
  }

  /** Unbind a computer: its token stops working at once. */
  @RequireAbility('update', 'PackingTerminal')
  @Post('devices/:id/revoke')
  @HttpCode(200)
  async revoke(@Req() request: FastifyRequest, @Param('id') id: string) {
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.terminals.revoke(requireContext(request), auditable(request), parse(idSchema, id));
  }

  @RequireAbility('update', 'PackingTerminal')
  @Put(':id')
  async update(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(terminalUpdateSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.terminals.update(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** Who works at the terminal (D-802): the whole list. */
  @RequireAbility('update', 'PackingTerminal')
  @Put(':id/members')
  async members(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(terminalMembersSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.terminals.setMembers(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** A packing terminal's cameras (D-804): the whole list. */
  @RequireAbility('update', 'PackingTerminal')
  @Put(':id/cameras')
  async cameras(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(terminalCamerasSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.terminals.setCameras(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** "This computer is Packing 2" (D-803): the token, once. */
  @RequireAbility('update', 'PackingTerminal')
  @Post(':id/bind')
  @HttpCode(200)
  async bind(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(terminalBindSchema, body);
    scopeHasNoRowDimension(request, NO_ROWS);
    return this.terminals.bind(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }
}
