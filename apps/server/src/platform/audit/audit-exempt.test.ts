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

describe('auditNothingChanged', () => {
  it('is called from these places and no others', () => {
    const sites: string[] = [];
    for (const file of sources(SRC)) {
      if (file.endsWith('audit.interceptor.ts')) continue;
      if (readFileSync(file, 'utf8').includes('auditNothingChanged(')) {
        sites.push(path.relative(SRC, file).split(path.sep).join('/'));
      }
    }
    expect(sites.sort()).toEqual([
      // M41 (D-713): a presence beat that changed nothing but the caller's last-seen instant.
      'modules/team/team.controller.ts',
    ]);
  });
});

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
      // M35b: the packing scanner app's sign-in (the device it creates is audited by the
      // packing module in its own transaction) and sign-out (the device row says when).
      'modules/iam/scanner-sign-in.ts#login',
      'modules/iam/scanner-sign-in.ts#post',
      // M42: Meta's webhook (D-732). No person acts; the body is stored and threaded by a job,
      // whose messages and conversations are the record.
      'modules/inbox/webhook.controller.ts#receive',
      // ncom.bd's connector (M35b, D-553, D-556): no session and no person. A stock read and an
      // unknown address change nothing; holds, handovers and webhooks are recorded in the
      // marketplace's own tables and the orders' audit, as ncom.
      'modules/marketplace/ncom.controller.ts#intake',
      'modules/marketplace/ncom.controller.ts#release',
      'modules/marketplace/ncom.controller.ts#reserve',
      'modules/marketplace/ncom.controller.ts#stock',
      'modules/marketplace/ncom.controller.ts#unknown',
      'modules/marketplace/ncom.controller.ts#webhook',
      // The label sheet (M35b, D-555) reads orders and writes nothing.
      'modules/packing/packing.controller.ts#labelsPdf',
      'modules/packing/scanner.controller.ts#signOut',
      // SSLCommerz's unsigned IPN (M34, D-525): it only enqueues a validation, whose outcome
      // the worker audits in the brand's log.
      'modules/storefront/sslcommerz-ipn.controller.ts#ipn',
      // The brand website's signed writes (M34, D-535): no session, so no request org; each
      // service writes its own audit row inside its transaction where it changes something
      // (an order, an account, a password, a payment), and the rest change nothing auditable
      // (a quote, a sign-in's timestamp, a code or link sent to an inbox, a payment page).
      'modules/storefront/storefront-buying.controller.ts#changePassword',
      'modules/storefront/storefront-buying.controller.ts#checkout',
      'modules/storefront/storefront-buying.controller.ts#forgotPassword',
      'modules/storefront/storefront-buying.controller.ts#google',
      'modules/storefront/storefront-buying.controller.ts#initPayment',
      'modules/storefront/storefront-buying.controller.ts#paymentReturn',
      'modules/storefront/storefront-buying.controller.ts#quote',
      'modules/storefront/storefront-buying.controller.ts#register',
      'modules/storefront/storefront-buying.controller.ts#resendCode',
      'modules/storefront/storefront-buying.controller.ts#resetPassword',
      'modules/storefront/storefront-buying.controller.ts#signIn',
      'modules/storefront/storefront-buying.controller.ts#updateAccount',
      'modules/storefront/storefront-buying.controller.ts#verifyEmail',
      // The website's campaign-link visit counter and its forwarded browser events (M35b,
      // D-551, D-552): no person decided either; the events have a log of their own.
      'modules/storefront/web-marketing.controller.ts#customLinkView',
      'modules/storefront/web-marketing.controller.ts#events',
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
