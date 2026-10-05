import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Post,
  Req,
} from '@nestjs/common';
import { defineAbilityFor, scannerSignInSchema, type ScannerSignIn } from '@elysium/contracts';
import { mustEnrolTwoFactor, resolveContext, withUser, type Auth } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public } from '../../platform/auth/abilities.js';
import { PACKING_API, type PackingApi } from '../packing/packing.api.js';
import { AUTH } from './iam.service.js';

function refusal(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

/** The cookies a Better Auth answer set, as a `Cookie` header for the next call. */
function cookiesOf(response: Response): string {
  const all = response.headers.getSetCookie();
  return all
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ');
}

/**
 * The packing scanner's sign-in (M35b, D-554): the old app's email and password, through Better
 * Auth's own sign-in so every rule the console's sign-in has applies here too — the password
 * hash, a disabled account, a brand switched off, and **two-step sign-in**: an account that has
 * an authenticator must send its six digits as `code` (or pair the phone from the console,
 * which it signed into with them); a role that must have one but has not enrolled is refused
 * until it does. The session Better Auth makes on the way is ended at once; what the phone
 * keeps is a 30-day device token, revocable, for one brand.
 *
 * The brand is the deployment's (one ERP per brand, D-469) or, where several are served, the
 * one brand the person holds a role in; a person in several is asked to pair from the console,
 * which knows the brand they chose.
 */
@Injectable()
export class ScannerSignInService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PACKING_API) private readonly packing: PackingApi,
  ) {}

  async signIn(input: ScannerSignIn) {
    const email = input.email.trim().toLowerCase();
    const first = await this.auth.api.signInEmail({
      body: { email, password: input.password },
      headers: new Headers(),
      asResponse: true,
    });
    if (first.status === 403) {
      throw refusal(HttpStatus.FORBIDDEN, 'ACCOUNT_INACTIVE', 'This account is not active.');
    }
    if (!first.ok) {
      throw refusal(
        HttpStatus.UNAUTHORIZED,
        'SCANNER_CREDENTIALS_INVALID',
        'Invalid email or password.',
      );
    }
    let body = (await first.json()) as {
      twoFactorRedirect?: unknown;
      user?: { id?: unknown; name?: unknown; email?: unknown };
    };
    let session = cookiesOf(first);
    if (body.twoFactorRedirect === true) {
      if (input.code === undefined) {
        throw refusal(
          HttpStatus.UNAUTHORIZED,
          'SCANNER_CODE_REQUIRED',
          'This account uses two-step sign-in: enter the code from the authenticator app, or connect the scanner from the console.',
        );
      }
      const second = await this.auth.api.verifyTOTP({
        body: { code: input.code },
        headers: new Headers({ cookie: session }),
        asResponse: true,
      });
      if (!second.ok) {
        throw refusal(
          HttpStatus.UNAUTHORIZED,
          'SCANNER_CREDENTIALS_INVALID',
          'That code was not accepted. Try the next one.',
        );
      }
      body = (await second.json()) as typeof body;
      session = cookiesOf(second);
    }
    // The phone keeps a device token, not the session Better Auth just made.
    await this.auth.api
      .signOut({ headers: new Headers({ cookie: session }) })
      .catch(() => undefined);

    const userId = typeof body.user?.id === 'string' ? body.user.id : '';
    if (userId === '') {
      throw refusal(
        HttpStatus.UNAUTHORIZED,
        'SCANNER_CREDENTIALS_INVALID',
        'Invalid email or password.',
      );
    }
    if (await mustEnrolTwoFactor(userId)) {
      throw refusal(
        HttpStatus.FORBIDDEN,
        'SCANNER_ENROLMENT_REQUIRED',
        'Your role needs two-step sign-in: set it up in the console first.',
      );
    }
    const orgId = await this.brandOf(userId);
    const context = await resolveContext({ userId, orgId, requestId: randomUUID() });
    if (context === null || !defineAbilityFor(context).can('read', 'Order')) {
      throw refusal(
        HttpStatus.FORBIDDEN,
        'SCANNER_NOT_ALLOWED',
        'This account cannot use the scanner.',
      );
    }
    const issued = await this.packing.issueDevice({
      orgId,
      userId,
      label: input.deviceName ?? 'Scanner',
    });
    return {
      token: issued.token,
      expiresAt: issued.device.expiresAt,
      user: {
        name: typeof body.user?.name === 'string' ? body.user.name : '',
        email,
        role: context.roles.join(', '),
      },
    };
  }

  /** The one brand this person may pack for here. */
  private async brandOf(userId: string): Promise<string> {
    const deployed = (process.env.ERP_BRAND_SLUG ?? '').trim();
    const rows = await withUser({ userId }, (tx) =>
      tx.execute<{ org_id: string; slug: string }>(sql`
        select distinct m.org_id, o.slug
        from iam.memberships m join org.organizations o on o.id = m.org_id
        where m.user_id = ${userId} and m.is_active and o.is_active
      `),
    );
    const candidates = [...rows].filter((row) => deployed === '' || row.slug === deployed);
    const only = candidates[0];
    if (candidates.length === 1 && only !== undefined) return only.org_id;
    if (candidates.length === 0) {
      throw refusal(
        HttpStatus.FORBIDDEN,
        'SCANNER_NOT_ALLOWED',
        'This account cannot use the scanner.',
      );
    }
    throw refusal(
      HttpStatus.CONFLICT,
      'SCANNER_BRAND_AMBIGUOUS',
      'This account works in more than one brand: connect the scanner from the console instead.',
    );
  }
}

/**
 * `POST /v1/scanner/sign-in` (D-554): public, as a sign-in is; rate-limited like the console's
 * (`CREDENTIAL_RULES`), exempt from the double-submit check (the app has no cookie), and readable
 * from the app's own origin (`cors.ts`).
 */
@Controller('v1/scanner')
export class ScannerSignInController {
  constructor(private readonly signIn: ScannerSignInService) {}

  @Public(
    'The packing scanner app signs in with an email and a password (and a second factor where the account has one), as the console does; the answer is a device token (D-554).',
  )
  @AuditExempt('The device it creates is audited by the packing module in its own transaction.')
  @Post('sign-in')
  @HttpCode(200)
  async post(@Req() _request: FastifyRequest, @Body() body: unknown) {
    const parsed = scannerSignInSchema.safeParse(body);
    if (!parsed.success) {
      throw refusal(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Email and password are required.',
      );
    }
    return this.signIn.signIn(parsed.data);
  }
}
