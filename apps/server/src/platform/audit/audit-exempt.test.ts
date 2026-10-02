import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { AuditInterceptor } from './audit.interceptor.js';

/**
 * Every route that is excused from the audit log, by name.
 *
 * `@AuditExempt` exists so a public route whose change is audited elsewhere, or that
 * changes nothing, stops the interceptor reporting "a mutation escaped the audit log" on
 * every request. A new exemption fails here until it is added to the list below, which is
 * where a reviewer reads its reason.
 */

const SRC = path.resolve(import.meta.dirname, '../..');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('@AuditExempt', () => {
  it('is on these routes and no others', () => {
    const exempt = sources(SRC)
      .filter((file) => readFileSync(file, 'utf8').includes('@AuditExempt('))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .sort();
    expect(exempt).toEqual([
      // A read sent as a POST to keep phone digits out of URLs.
      'modules/courier/tracking.controller.ts',
      // A pending upload's bytes; the ticket and the finalize are audited in the org.
      'modules/files/files.controller.ts',
    ]);
  });

  const handler = { getHandler: () => undefined, getClass: () => undefined };
  const write = (interceptor: AuditInterceptor, request: object) =>
    (interceptor as unknown as { write: (...args: unknown[]) => Promise<void> }).write(
      request,
      handler,
      {},
    );

  it('keeps the interceptor quiet for an exempt route', async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue('a reason') };
    const error = vi.fn();
    await write(new AuditInterceptor(reflector as never, {} as never), {
      method: 'PUT',
      url: '/v1/files/content?t=x',
      log: { error },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('still reports an unaudited mutation on any other route', async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
    const error = vi.fn();
    await write(new AuditInterceptor(reflector as never, {} as never), {
      method: 'POST',
      url: '/v1/somewhere',
      log: { error },
    });
    expect(error).toHaveBeenCalledOnce();
  });
});
