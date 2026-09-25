import { ERROR_CODES } from '@elysium/contracts';
import { describe, expect, it } from 'vitest';

import { readHttpExceptionBody } from './problem.filter.js';
import { codeForStatus, instanceOf, problemFor, titleFor, typeFor } from './problem.js';

describe('the problem document (§23, RFC 9457)', () => {
  it('carries every member RFC 9457 names, and the code clients branch on', () => {
    expect(
      problemFor({
        status: 409,
        code: 'PERIOD_CLOSED',
        detail: '2026-05-31 falls in 2026-05, which is closed',
        instance: '/v1/ledger/cash-in',
      }),
    ).toEqual({
      type: '/problems/period-closed',
      title: 'Period closed',
      status: 409,
      code: 'PERIOD_CLOSED',
      detail: '2026-05-31 falls in 2026-05, which is closed',
      instance: '/v1/ledger/cash-in',
    });
  });

  it('gives every published code a type and a title, so none renders blank', () => {
    for (const code of ERROR_CODES) {
      expect(typeFor(code), code).toMatch(/^\/problems\/[a-z-]+$/);
      expect(titleFor(code), code).toMatch(/^[A-Z]/);
      expect(titleFor(code), code).not.toContain('_');
    }
  });

  it('derives a code from the status when nothing threw one', () => {
    expect(problemFor({ status: 403 }).code).toBe('FORBIDDEN');
    expect(problemFor({ status: 404 }).code).toBe('NOT_FOUND');
    expect(codeForStatus(429)).toBe('RATE_LIMITED');
  });

  it('replaces a code that is not in the published set rather than passing it on', () => {
    // A typo'd code is indistinguishable, to a client, from one it has not been
    // taught — so it would fall into the client's default branch unnoticed.
    expect(problemFor({ status: 409, code: 'PERIOD_CLOSD' }).code).toBe('CONFLICT');
  });

  it('falls back sensibly for a status with no entry', () => {
    expect(codeForStatus(418)).toBe('VALIDATION_FAILED');
    expect(codeForStatus(507)).toBe('INTERNAL_ERROR');
  });

  it('omits empty members instead of sending null', () => {
    const document = problemFor({ status: 500, detail: '', errors: [] });
    expect(document).not.toHaveProperty('detail');
    expect(document).not.toHaveProperty('errors');
    expect(document).not.toHaveProperty('instance');
  });

  it('strips the query string from the instance', () => {
    // A filter here carries a customer's phone number, and an error body is the
    // thing most likely to be pasted into a bug report (invariant 10).
    expect(instanceOf('/v1/orders?phone=01712345678')).toBe('/v1/orders');
    expect(instanceOf('/v1/orders')).toBe('/v1/orders');
  });
});

describe('reading whatever was thrown', () => {
  it('takes a bare string as the detail', () => {
    expect(readHttpExceptionBody('Say why the period must reopen.', 'fallback')).toEqual({
      code: undefined,
      detail: 'Say why the period must reopen.',
      errors: undefined,
    });
  });

  it("keeps the ledger's code and message", () => {
    expect(readHttpExceptionBody({ code: 'PERIOD_CLOSED', message: 'closed' }, 'x')).toEqual({
      code: 'PERIOD_CLOSED',
      detail: 'closed',
      errors: undefined,
    });
  });

  it("reads Nest's own shape without publishing its `error` as a code", () => {
    const read = readHttpExceptionBody(
      { statusCode: 400, message: 'No such record.', error: 'Bad Request' },
      'x',
    );
    expect(read.code).toBeUndefined();
    expect(read.detail).toBe('No such record.');
  });

  it('turns a list of messages into field errors rather than dropping them', () => {
    const read = readHttpExceptionBody({ message: ['a is required', 'b must be a uuid'] }, 'x');
    expect(read.detail).toBe('The request body failed validation.');
    expect(read.errors).toEqual([
      { path: '', message: 'a is required' },
      { path: '', message: 'b must be a uuid' },
    ]);
  });

  it('falls back to the exception message when the body says nothing', () => {
    expect(readHttpExceptionBody({}, 'Forbidden').detail).toBe('Forbidden');
    expect(readHttpExceptionBody(null, 'Forbidden').detail).toBe('Forbidden');
  });
});
