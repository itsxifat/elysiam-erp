import { Body, Controller, Header, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ownerLinkSignInSchema } from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../platform/auth/abilities.js';
import { NoIdempotencyReplay } from '../../platform/http/idempotency.interceptor.js';
import { OwnerLinkService } from './owner-link.service.js';

/**
 * `POST /v1/auth/owner-link` (M31, D-473): an owner sign-in link, exchanged for a session.
 *
 * The console's `/owner-link` page reads the token from the URL fragment (which no browser
 * sends to a server) and posts it here. The answer sets the session cookie exactly as a
 * sign-in does and says nothing else; the console then opens on the brand.
 *
 * Public by necessity — the person has no session yet — and as narrow as a public route
 * gets: off unless the brand has a public key, rate-limited per address
 * (`CREDENTIAL_RULES`), every link single use, and every refusal the same `401`.
 */
@Controller('v1/auth')
export class OwnerLinkController {
  constructor(private readonly ownerLink: OwnerLinkService) {}

  @Public(
    'An owner sign-in link is its own credential: a two-minute, single-use assertion signed ' +
      'by the owner key and checked with the public key in this brand’s environment (D-473).',
  )
  @Post('owner-link')
  @HttpCode(200)
  // The answer carries a session cookie: never cached, never stored for replay.
  @Header('Cache-Control', 'no-store')
  @NoIdempotencyReplay()
  async signIn(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const parsed = ownerLinkSignInSchema.safeParse(body);
    // A body that is not a token is refused the way a bad token is: one answer for all.
    const result = await this.ownerLink.signIn(parsed.success ? parsed.data.token : '', request);
    void reply.header('set-cookie', [...result.cookies]);
    return { ok: true };
  }
}
