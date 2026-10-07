import {
  Catch,
  HttpException,
  Injectable,
  SetMetadata,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { z } from 'zod';

import type { Actor } from '../audit/audit.js';
import type { OwnerRequest } from './auth-plugin.js';
import { instanceOf, MotherError, PROBLEM_CONTENT_TYPE, problemFor } from './errors.js';

/**
 * The mother's request pipeline in Nest (D-480): every route needs a signed-in owner with a
 * second factor unless it says `@Public()`; every failure answers problem+json; every input
 * is parsed with the shared Zod schemas.
 */

const PUBLIC_KEY = 'mother:public';

/** A route anyone may call: the health checks, nothing else. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const open = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (open === true) return true;
    const request = context.switchToHttp().getRequest<OwnerRequest>();
    if (request.owner === undefined) {
      throw new MotherError('UNAUTHENTICATED', 'Sign in first.');
    }
    return true;
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const instance = instanceOf(request.url);
    let body;
    if (exception instanceof MotherError) {
      body = problemFor({
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        instance,
        ...(exception.errors === undefined ? {} : { errors: exception.errors }),
      });
      if (exception.status >= 500) {
        this.logger.error({ err: exception, path: instance }, 'request failed');
      }
    } else if (exception instanceof HttpException) {
      body = problemFor({ status: exception.getStatus(), instance });
    } else {
      this.logger.error({ err: exception, path: instance }, 'unhandled error');
      body = problemFor({ status: 500, code: 'INTERNAL_ERROR', instance });
    }
    void reply.status(body.status).header('content-type', PROBLEM_CONTENT_TYPE).send(body);
  }
}

/** Parse with a shared schema, or refuse with each field's problem. */
export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MotherError(
      'VALIDATION_FAILED',
      'Some of what was sent is not valid.',
      400,
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Who is acting, for the audit log. The guard has made sure there is an owner. */
export function actorOf(request: FastifyRequest): Actor {
  const owner = (request as OwnerRequest).owner;
  if (owner === undefined) throw new MotherError('UNAUTHENTICATED', 'Sign in first.');
  return {
    userId: owner.id,
    email: owner.email,
    name: owner.name,
    ipAddress: request.ip,
    requestId: (request as OwnerRequest).requestId ?? null,
  };
}
