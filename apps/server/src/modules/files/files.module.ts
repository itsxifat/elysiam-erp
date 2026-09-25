import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES } from '@elysium/integrations';
import type { FastifyInstance } from 'fastify';

import { serverEnv } from '../../platform/config/env.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { createStorageDriver, filesEnv } from './files.config.js';
import { GotenbergClient } from './pdf/gotenberg.client.js';

/**
 * Teach Fastify to accept the bytes of an upload.
 *
 * Fastify ships parsers for JSON and urlencoded and nothing else, so a
 * presigned `PUT` carrying `image/png` is answered 415 before any handler runs
 * — the request never reaches the route that would have checked the token.
 * Registering a raw parser per allowed type is what makes the local driver's
 * upload path work at all.
 *
 * Deliberately *only* the types on the allow-list: registering `*` would make
 * this process willing to buffer any body anybody sends, which is a memory
 * budget set by strangers. `bodyLimit` bounds each one, and the per-type
 * ceiling is checked again in the service against the ticket that was issued.
 *
 * An `OnModuleInit` rather than a line in `main.api.ts`, so the HTTP tests —
 * which build the application from `AppModule` and never touch that file — get
 * the same parsers production does.
 */
@Injectable()
export class FileUploadBodyParser implements OnModuleInit {
  constructor(private readonly adapters: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapters.httpAdapter?.getInstance<FastifyInstance>();
    if (instance === undefined) return;

    for (const rule of ALLOWED_MIME_TYPES) {
      if (instance.hasContentTypeParser(rule.mime)) continue;
      instance.addContentTypeParser(
        rule.mime,
        { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
        (_request, body, done) => {
          done(null, body);
        },
      );
    }
  }
}

/**
 * Files and documents (architecture §22).
 *
 * The storage driver is chosen once, here, from configuration, and injected.
 * Nothing downstream can pick a different one: a service that could choose
 * would eventually choose the local driver in a test and pass while production
 * ran on R2, which is the class of bug where the test is the problem.
 *
 * `GotenbergClient` is exported so later milestones' document templates —
 * packing slip, courier label, payslip, statements (§22) — reach it through
 * this module rather than each constructing their own with their own base URL.
 */
@Module({
  controllers: [FilesController],
  providers: [
    FileUploadBodyParser,
    {
      provide: FilesService,
      useFactory: () => {
        const env = filesEnv();
        const server = serverEnv();
        return new FilesService(
          createStorageDriver({
            env,
            apiPublicUrl: server.API_PUBLIC_URL,
            authSecret: server.AUTH_SECRET,
          }),
          env.FILE_URL_TTL_SECONDS,
          env.FILE_UPLOAD_TTL_SECONDS,
        );
      },
    },
    {
      provide: GotenbergClient,
      useFactory: () => new GotenbergClient(filesEnv().GOTENBERG_URL),
    },
  ],
  exports: [FilesService, GotenbergClient],
})
export class FilesModule {}
