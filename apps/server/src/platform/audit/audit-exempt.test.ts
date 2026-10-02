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
  it('is on these handlers and no others, never on a class', () => {
    const exempt: string[] = [];
    for (const file of sources(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('@AuditExempt(')) return;
        // The decorated thing: the next line that starts a method or a class.
        const target = lines
          .slice(index + 1)
          .find((next) => /^\s*(export class |async \w+\()/.test(next));
        const method = /^\s*async (\w+)\(/.exec(target ?? '')?.[1] ?? '<class>';
        exempt.push(`${path.relative(SRC, file).split(path.sep).join('/')}#${method}`);
      });
    }
    expect(exempt.sort()).toEqual([
      // A read sent as a POST to keep phone digits out of URLs.
      'modules/courier/tracking.controller.ts#track',
      // A pending upload's bytes; the ticket and the finalize are audited in the org.
      'modules/files/files.controller.ts#upload',
    ]);
  });

  const handler = { getHandler: () => undefined, getClass: () => undefined };
  const write = (interceptor: AuditInterceptor, request: object) =>
    (interceptor as unknown as { write: (...args: unknown[]) => Promise<void> }).write(
      request,
      handler,
      {},
    );

  it('keeps the interceptor quiet for an exempt route with no org', async () => {
    const reflector = { get: vi.fn().mockReturnValue('a reason') };
    const error = vi.fn();
    await write(new AuditInterceptor(reflector as never, {} as never), {
      method: 'PUT',
      url: '/v1/files/content?t=x',
      log: { error },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('still reports an unaudited mutation on any other route', async () => {
    const reflector = { get: vi.fn().mockReturnValue(undefined) };
    const error = vi.fn();
    await write(new AuditInterceptor(reflector as never, {} as never), {
      method: 'POST',
      url: '/v1/somewhere',
      log: { error },
    });
    expect(error).toHaveBeenCalledOnce();
  });

  it('never drops an org audit row because a route is exempt', async () => {
    // The ability lookup that names the audit row comes right after the no-org branch; it
    // throws here so the test stops before any database work.
    const reflector = {
      get: vi.fn().mockReturnValue('a reason'),
      getAllAndOverride: vi.fn(() => {
        throw new Error('went on to write the org audit row');
      }),
    };
    const request = {
      method: 'POST',
      url: '/v1/somewhere',
      context: { orgId: '00000000-0000-4000-8000-000000000001', userId: 'u' },
      log: { error: vi.fn() },
    };
    await expect(
      write(new AuditInterceptor(reflector as never, {} as never), request),
    ).rejects.toThrow('went on to write the org audit row');
  });
});
