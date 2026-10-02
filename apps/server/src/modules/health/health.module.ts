import { Module, type DynamicModule } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { EXTRA_READINESS_PROBES, ReadinessService, type ReadinessProbes } from './readiness.js';

@Module({})
export class HealthModule {
  /**
   * `extra` adds probes to the database and jobs checks every API has. The running API adds
   * Valkey's (`main.api.ts`); a test suite that boots without Valkey adds nothing, and its
   * readiness reports the two it does have.
   */
  static register(extra: ReadinessProbes = {}): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: EXTRA_READINESS_PROBES, useValue: extra }, ReadinessService],
    };
  }
}
