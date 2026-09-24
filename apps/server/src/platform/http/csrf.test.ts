import { describe, expect, it } from 'vitest';

import { checkCsrf, CSRF_COOKIE, CSRF_HEADER, issueCsrfToken, type CsrfOptions } from './csrf.js';

/**
 * The CSRF checks, one branch at a time (§25).
 *
 * `http-surface.test.ts` drives these through a real server, which is the right
 * place to prove they are mounted — but it cannot easily say *which* check
 * refused, because a forged cookie sent alongside a real one is refused by the
 * comparison before the signature is ever considered. The two hardening rules
 * this milestone added are both about a branch that fires before the
 * comparison, so they are asserted here where the input is exact.
 */

const SECRET = 'a-test-secret-that-is-at-least-32-characters';

const OPTIONS: CsrfOptions = {
  trustedOrigins: ['https://console.erp.test'],
  secret: SECRET,
  secure: false,
};

/** A real token, taken from what `issueCsrfToken` would set. */
function realToken(): string {
  let captured = '';
  const reply = {
    setCookie(_name: string, value: string) {
      captured = value;
      return this;
    },
  };
  const returned = issueCsrfToken(reply as never, OPTIONS);
  expect(returned, 'the cookie and the return value must be the same token').toBe(captured);
  return returned;
}

interface RequestShape {
  method?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

function request(shape: RequestShape) {
  return {
    method: shape.method ?? 'POST',
    headers: shape.headers ?? {},
    cookies: shape.cookies ?? {},
  } as never;
}

function withToken(token: string, headers: Record<string, string> = {}) {
  return request({
    headers: { origin: 'https://console.erp.test', [CSRF_HEADER]: token, ...headers },
    cookies: { [CSRF_COOKIE]: token },
  });
}

describe('a token this server did not issue', () => {
  /*
   * The attack plain double-submit does not stop on this domain.
   *
   * Cookies are scoped by domain and ignore ports, so any host under
   * `<APP_DOMAIN>` can write `elysium_csrf` for the parent — and "same-site"
   * includes subdomains, so `SameSite=Lax` still sends the session cookie on a
   * form POST from one. CORS does not help, because a form POST is not a CORS
   * request. The hosts under this domain are not all ours: D-026 puts landing
   * sites on Vercel and §16 puts Chatwoot on the parent domain.
   *
   * The planted cookie and the planted header agree perfectly. The only thing
   * that separates them from a real pair is the signature.
   */
  it('is refused even when the cookie and the header agree exactly', () => {
    const forged = `${'a'.repeat(43)}.${'b'.repeat(43)}`;
    const result = checkCsrf(withToken(forged), OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not issued by this server');
  });

  it('is refused when the value is real but the signature is another token’s', () => {
    const [valueOfOne] = realToken().split('.');
    const [, signatureOfAnother] = realToken().split('.');
    const spliced = `${valueOfOne ?? ''}.${signatureOfAnother ?? ''}`;

    expect(checkCsrf(withToken(spliced), OPTIONS).ok).toBe(false);
  });

  it('is refused when it carries no signature at all', () => {
    // What the previous implementation issued: 32 random bytes and nothing
    // else. A token from before this change is not accepted, which is correct
    // and costs a client one safe request to pick up a new one.
    expect(checkCsrf(withToken('a'.repeat(43)), OPTIONS).ok).toBe(false);
  });

  it('is refused when signed with a different secret', () => {
    const other = issueCsrfTokenWith({
      ...OPTIONS,
      secret: 'a-completely-different-secret-value!!',
    });
    expect(checkCsrf(withToken(other), OPTIONS).ok).toBe(false);
  });

  it('accepts a real one, so the four refusals above are about authenticity', () => {
    const result = checkCsrf(withToken(realToken()), OPTIONS);
    expect(result.ok, result.reason).toBe(true);
  });
});

describe('Sec-Fetch-Site, for when Origin is absent', () => {
  /*
   * The origin check is skipped entirely when the header is absent, and a form
   * navigation is one of the cases a browser may omit it in. Every browser
   * that omits it sends this instead, and page script can set neither — both
   * are forbidden header names.
   */
  const token = realToken();

  it('refuses a cross-site request with no Origin', () => {
    const result = checkCsrf(
      request({
        headers: { [CSRF_HEADER]: token, 'sec-fetch-site': 'cross-site' },
        cookies: { [CSRF_COOKIE]: token },
      }),
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('cross-site');
  });

  it('allows same-origin and same-site, which are ours by definition', () => {
    for (const site of ['same-origin', 'same-site']) {
      const result = checkCsrf(withToken(token, { 'sec-fetch-site': site }), OPTIONS);
      expect(result.ok, `${site}: ${result.reason ?? ''}`).toBe(true);
    }
  });

  it('allows `none`, which is a typed URL or a bookmark rather than an attack', () => {
    expect(checkCsrf(withToken(token, { 'sec-fetch-site': 'none' }), OPTIONS).ok).toBe(true);
  });

  it('allows an older client that sends neither header', () => {
    const result = checkCsrf(
      request({ headers: { [CSRF_HEADER]: token }, cookies: { [CSRF_COOKIE]: token } }),
      OPTIONS,
    );
    expect(result.ok, result.reason).toBe(true);
  });
});

describe('the checks that were already here still hold', () => {
  const token = realToken();

  it('never demands anything of a safe method', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkCsrf(request({ method }), OPTIONS).ok).toBe(true);
    }
  });

  it('refuses an untrusted origin before it looks at the token', () => {
    const result = checkCsrf(withToken(token, { origin: 'https://evil.test' }), OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('evil.test');
  });

  it('refuses a missing cookie and a missing header separately', () => {
    expect(checkCsrf(request({ headers: { [CSRF_HEADER]: token } }), OPTIONS).reason).toContain(
      'no CSRF cookie',
    );
    expect(checkCsrf(request({ cookies: { [CSRF_COOKIE]: token } }), OPTIONS).reason).toContain(
      CSRF_HEADER,
    );
  });

  it('refuses a header that does not match the cookie', () => {
    const other = realToken();
    const result = checkCsrf(
      request({
        headers: { origin: 'https://console.erp.test', [CSRF_HEADER]: other },
        cookies: { [CSRF_COOKIE]: token },
      }),
      OPTIONS,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('mismatch');
  });

  it('refuses an empty cookie, which `timingSafeEqual` would otherwise compare happily', () => {
    const result = checkCsrf(
      request({
        headers: { origin: 'https://console.erp.test', [CSRF_HEADER]: '' },
        cookies: { [CSRF_COOKIE]: '' },
      }),
      OPTIONS,
    );
    expect(result.ok).toBe(false);
  });
});

/** `issueCsrfToken` against a throwaway reply, for a chosen set of options. */
function issueCsrfTokenWith(options: CsrfOptions): string {
  const reply = {
    setCookie() {
      return this;
    },
  };
  return issueCsrfToken(reply as never, options);
}
