import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The API's response headers (architecture §25; M14b security review, D-349).
 *
 * The API answers JSON, problem documents and file downloads, and no response is meant to
 * be rendered as a page, framed, sniffed into HTML or kept by a shared cache:
 *
 * - `X-Content-Type-Options: nosniff` and a CSP of `default-src 'none'` on everything, so
 *   a response a browser is tricked into opening runs nothing.
 * - `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
 * - `Referrer-Policy: no-referrer`: a URL here can carry an id worth not leaking.
 * - `Cache-Control: no-store` unless the route chose its own (the signed file download
 *   says `private, no-store`, and keeps it). Cloudflare sits in front; nothing personal
 *   should ever be a cache candidate.
 * - `Strict-Transport-Security` when cookies are `Secure`, i.e. in production.
 *
 * Registered by `registerAuth`, so the running API and every HTTP test suite carry it.
 * Socket.IO's handshake is answered by engine.io before Fastify and is not covered; it
 * serves no document.
 */
export function registerSecurityHeaders(app: FastifyInstance, options: { hsts: boolean }): void {
  app.addHook('onSend', (_request: FastifyRequest, reply: FastifyReply, payload: unknown, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    if (options.hsts) {
      void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    done(null, payload);
  });
}
