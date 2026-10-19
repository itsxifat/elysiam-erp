import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuthenticatedOnly } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { IamApiService } from './iam.api.js';

/** At most this many people a call; a screen names far fewer. */
export const STAFF_NAMES_MAX = 200;

/** A person's id; a worker's or a channel's actor (`system:…`, `intake:…`) is nobody to name. */
const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/;

const staffNamesQuerySchema = z.object({
  ids: z
    .string()
    .max(STAFF_NAMES_MAX * 65)
    .transform((value) => [...new Set(value.split(',').filter((id) => PERSON_ID.test(id)))])
    .pipe(z.array(z.string()).max(STAFF_NAMES_MAX)),
});

/**
 * The names behind the staff ids a screen shows (D-898): who took an order, wrote a note, asked
 * for an approval, printed a label. Records keep a person's id; the console asks for their
 * names here rather than showing the id. Whoever holds or ever held a role in this brand and
 * every super admin; an owner is named only to another owner (D-473), and an id the brand's
 * records cannot mention is left out.
 *
 * `@AuthenticatedOnly`: a colleague's name is no record of any subject, and every staff member
 * reads the records that carry these ids. A partner outside the company (a reseller, an
 * investor) is handed no names.
 */
@Controller('v1/staff-names')
export class StaffNamesController {
  constructor(private readonly iam: IamApiService) {}

  @AuthenticatedOnly('Names the colleagues on records the caller already reads; ids in, names out.')
  @Get()
  async names(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = staffNamesQuerySchema.safeParse(query ?? {});
    if (!parsed.success)
      throw new BadRequestException('ids: up to 200 staff ids, comma-separated.');
    const context = requireContext(request);
    const staff =
      context.isSuperAdmin ||
      context.roles.some((role) => role !== 'reseller' && role !== 'investor');
    if (!staff) return { people: [] };
    const people = await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      this.iam.namesOf(tx, context.orgId, parsed.data.ids, context),
    );
    return { people };
  }
}
