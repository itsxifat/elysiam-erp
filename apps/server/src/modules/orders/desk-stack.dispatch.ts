import { withGlobal, withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { serverEnv } from '../../platform/config/env.js';
import { claimPending, markDispatched } from '../../platform/events/outbox.js';
import { createLogger } from '../../platform/logging/logger.js';
import { createRealtimeEmitter } from '../../platform/realtime/index.js';

/**
 * A stand-in for the worker's outbox claim, for the order desk's Playwright run only.
 *
 * **Why it exists.** `OutboxDispatcher.drain()` claims with `withSystem()`: `erp_owner`,
 * no `app.org_id`. `events.outbox` is FORCE RLS and `erp_owner` is NOBYPASSRLS (D-042), so
 * the real worker's claim matches no row and nothing is ever delivered — the defect
 * `platform/realtime/realtime.e2e.test.ts` records and works around the same way. It is a
 * platform defect, in a file M11 may not edit; M11's report hands the integrator the fix.
 *
 * **What it is.** The same delivery, claimed per org: for each organization, inside that
 * org's `withOrg()`, `claimPending` → the Valkey emitter's `deliver` (exactly what
 * `bridgeOutboxToRealtime` calls) → `markDispatched`. The outbox rows, the emitter, the
 * Valkey adapter, the API's gateway and the browser's socket are all the real ones; only the
 * claim differs, and it differs in the way the fix will.
 *
 * Opt-in: the stack runs it only with `E2E_STACK_OUTBOX=per-org`. Without it, check 4 runs
 * against the real worker alone — and fails until the dispatcher is fixed, which is the
 * honest state of the tree.
 *
 * Stops when its stdin says `stop` or closes, like the provisioning process.
 */

const POLL_MS = 250;

async function main(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('desk-stack-dispatch');
  const realtime = createRealtimeEmitter({
    logger,
    valkey: { url: env.VALKEY_URL, key: env.REALTIME_ADAPTER_KEY },
  });

  let stopping = false;
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffered += chunk;
    if (buffered.includes('stop')) stopping = true;
  });
  process.stdin.on('end', () => {
    stopping = true;
  });

  const orgs = await withGlobal(async (tx) =>
    tx.execute<{ id: string }>(sql`select id from org.organizations`),
  );

  while (!stopping) {
    let delivered = 0;
    for (const { id: orgId } of orgs) {
      const pending = await withOrg({ orgId }, (tx) => claimPending(tx, 50));
      for (const row of pending) {
        realtime.deliver({
          id: row.id,
          orgId: row.orgId,
          name: row.name,
          payload: row.payload,
          rooms: row.rooms,
        });
        await withOrg({ orgId }, (tx) => markDispatched(tx, row.id));
        delivered += 1;
      }
    }
    if (delivered === 0) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  await realtime.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `desk-stack dispatch failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
