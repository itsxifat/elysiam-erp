import { Global, Module } from '@nestjs/common';

import { FlagsService } from './flags.service.js';

/**
 * Feature flags, available everywhere (D-031).
 *
 * `@Global` because the alternative is every future module importing
 * `FlagsModule` to ask one question, and because the service holds a cache:
 * one instance per process is the point, and a second instance would answer
 * from its own stale copy.
 */
@Global()
@Module({
  providers: [FlagsService],
  exports: [FlagsService],
})
export class FlagsModule {}
