import { Controller, Get } from '@nestjs/common';

import { Public } from '../../platform/auth/abilities.js';

@Controller('health')
export class HealthController {
  /**
   * Liveness only: the process is up and the event loop is turning.
   *
   * `/health/ready`, which checks Postgres, Valkey and pg-boss, arrives with
   * those dependencies in M01 and M04 (architecture §26).
   */
  @Public('Liveness. A probe that needed a session could not tell you the process was up.')
  @Get('live')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
