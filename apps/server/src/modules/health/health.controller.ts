import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /**
   * Liveness only: the process is up and the event loop is turning.
   *
   * `/health/ready`, which checks Postgres, Valkey and pg-boss, arrives with
   * those dependencies in M01 and M04 (architecture §26).
   */
  @Get('live')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
