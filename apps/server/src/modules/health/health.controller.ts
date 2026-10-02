import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '../../platform/auth/abilities.js';
import { ReadinessService, type ReadinessReport } from './readiness.js';

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness only: the process is up and the event loop is turning. */
  @Public('Liveness. A probe that needed a session could not tell you the process was up.')
  @Get('live')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /**
   * Readiness (architecture §26): the database, the job queue's schema and Valkey answer.
   *
   * 200 when every check passes, 503 naming the one that did not. kamal-proxy holds a new
   * release out of traffic until this says 200 (`infra/kamal/deploy.yml`), and the uptime
   * monitor watches it (`docs/runbooks/monitoring.md`).
   */
  @Public(
    'Readiness. A deploy probe or uptime monitor has no session; it learns only which dependency is down.',
  )
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    void reply.status(report.status === 'ok' ? 200 : 503).header('cache-control', 'no-store');
    return report;
  }
}
