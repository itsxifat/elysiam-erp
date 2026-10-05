import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { HeadsService } from './heads.service.js';
import { mapWalletErrors } from './wallets.errors.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const idSchema = z.string().uuid('No such head.');
const nameSchema = z.string().trim().min(1, 'A name is required.').max(120);

const createHeadSchema = z
  .object({ name: nameSchema, kind: z.enum(['income', 'expense']) })
  .strict();

const updateHeadSchema = z
  .object({ name: nameSchema.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.isActive !== undefined,
    'Nothing to change.',
  );

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The brand's expense and income heads (M39a, D-634): list, add, rename, archive, restore.
 * `update Wallet` (org_admin and accounts; a branch manager's branch scope is refused inside,
 * because a head is the whole brand's). Never deleted (§7).
 */
@Controller('v1/accounts')
export class HeadsController {
  constructor(private readonly heads: HeadsService) {}

  @RequireAbility('update', 'Wallet')
  @Get('heads')
  async list(@Req() request: FastifyRequest) {
    return mapWalletErrors(() => this.heads.list(requireContext(request), request));
  }

  @RequireAbility('update', 'Wallet')
  @Post('heads')
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createHeadSchema, body);
    return mapWalletErrors(() =>
      this.heads.create(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Wallet')
  @Patch('heads/:id')
  async update(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const headId = parse(idSchema, id);
    const patch = parse(updateHeadSchema, body);
    return mapWalletErrors(() =>
      this.heads.update(requireContext(request), auditable(request), headId, patch),
    );
  }
}
