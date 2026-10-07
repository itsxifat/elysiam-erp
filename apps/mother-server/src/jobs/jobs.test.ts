import type { PgBoss } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import { sendPull } from './jobs.js';

/** What `sendPull` asks pg-boss for, without a database. */
function recorder(): { boss: PgBoss; keys: string[] } {
  const keys: string[] = [];
  const boss = {
    send: (_queue: string, _data: unknown, options: { singletonKey?: string }) => {
      keys.push(options.singletonKey ?? '');
      return Promise.resolve('job');
    },
  } as unknown as PgBoss;
  return { boss, keys };
}

describe('sendPull (D-484)', () => {
  it('gives a full pull its own key, so a tick queued for the brand never swallows it', async () => {
    const { boss, keys } = recorder();
    await sendPull(boss, { brandId: 'b1', trigger: 'schedule', full: false });
    await sendPull(boss, { brandId: 'b1', trigger: 'nightly', full: true });
    await sendPull(boss, { brandId: 'b2', trigger: 'schedule', full: false });
    expect(keys).toEqual(['b1', 'b1:full', 'b2']);
  });
});
