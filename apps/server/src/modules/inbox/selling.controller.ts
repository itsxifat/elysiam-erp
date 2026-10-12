import { BadRequestException, Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { InboxSellingService } from './selling.service.js';

const idSchema = z.string().uuid('No such record.');

/** Something typed, or the customer's interests by id; never both, never neither. */
const productQuerySchema = z.union([
  z.object({ q: z.string().trim().min(1).max(100) }).strict(),
  z
    .object({
      ids: z
        .string()
        .transform((value) => value.split(',').filter((part) => part !== ''))
        .pipe(z.array(z.string().uuid()).min(1).max(20)),
    })
    .strict(),
]);

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message:
        issue === undefined
          ? 'That is not valid.'
          : `${issue.path.join('.') || 'query'}: ${issue.message}`,
    });
  }
  return parsed.data;
}

/**
 * Selling from the chat over HTTP (M44b, D-770 to D-773): the side card's brand facts, the
 * product picker and a product's size chart. Reads, under `read Conversation` like the rest of
 * the customer panel (D-736): whoever answers the inbox sells from it. The order is placed
 * through `POST /v1/orders` (`create Order`), the order desk's own route.
 */
@Controller('v1/inbox')
export class InboxSellingController {
  constructor(private readonly selling: InboxSellingService) {}

  /** The brand's colour names and website host, for reading a chat. */
  @RequireAbility('read', 'Conversation')
  @Get('selling-context')
  async context(@Req() request: FastifyRequest) {
    return this.selling.context(requireContext(request));
  }

  /** The picker: `?q=` what was typed (name, SKU, parent SKU, barcode, slug), or `?ids=`. */
  @RequireAbility('read', 'Conversation')
  @Get('products')
  async products(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.selling.products(requireContext(request), parse(productQuerySchema, query ?? {}));
  }

  @RequireAbility('read', 'Conversation')
  @Get('size-charts/:id')
  async sizeChart(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.selling.sizeChart(requireContext(request), parse(idSchema, id));
  }
}
