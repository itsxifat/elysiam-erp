import { CSRF_HEADER } from './csrf.js';
import { IDEMPOTENCY_HEADER } from './idempotency.js';
import { isTrustedOrigin, type OriginPolicy } from './origins.js';

/**
 * Every method a browser client sends to this API.
 *
 * Listed because `@fastify/cors` allows only `GET, HEAD, POST` unless told
 * otherwise, and a preflight that does not name the method fails in the browser
 * before the request is sent. The console's catalog price and image-order PUTs,
 * its image and payroll-input DELETEs, and the upload PUT to the local storage
 * driver all went that way — while every server test passed, because `inject`
 * never preflights.
 */
export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * The CORS options (architecture §25), as one value the boot code registers and
 * the test exercises.
 *
 * The console, the portal and the POS are served from their own origins and
 * talk to this API cross-origin, with cookies. That combination has two hard
 * requirements the browser enforces: the allowed origin must be echoed
 * exactly — `*` is rejected outright once credentials are involved — and
 * `credentials` must be true, or the session cookie is simply never sent and
 * every request looks anonymous.
 */
function credentialedOptions(policy: OriginPolicy) {
  return {
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow: boolean) => void,
    ) => {
      // No Origin header at all is a same-origin or non-browser request; CORS
      // has nothing to decide, and CSRF still applies to it.
      if (origin === undefined) {
        callback(null, true);
        return;
      }
      callback(null, isTrustedOrigin(origin, policy));
    },
    credentials: true,
    methods: [...CORS_METHODS],
    // The double-submit token rides in a custom header, which means every
    // mutation is preflighted. Omitting it here would fail them all.
    // §23's `Idempotency-Key` belongs here too, and leaving it out made the
    // whole feature unreachable: a custom request header triggers a CORS
    // preflight, and a preflight that does not list the header fails before the
    // request is sent. Every browser client would have been silently unable to
    // send one, while the server-side tests — which use `inject` and never
    // preflight — passed.
    // M42 (D-737): the inbox's acknowledgement that a conversation is someone else's.
    allowedHeaders: ['content-type', CSRF_HEADER, IDEMPOTENCY_HEADER, 'x-acknowledge-owner'],
    maxAge: 600,
  };
}

/**
 * The packing scanner's device routes (M35b, D-554): called by the native scanner app, whose
 * WebView is its own origin (`https://localhost` under Capacitor), with a bearer device token
 * and never a cookie. Any origin may read them, with no credentials: a page elsewhere that
 * calls them carries no token, and the browser sends no cookie for a non-credentialed request.
 */
export const SCANNER_DEVICE_PATHS: readonly string[] = [
  '/v1/scanner/sign-in',
  '/v1/scanner/sign-out',
  '/v1/scanner/shipment',
  // The same two, at the old site's addresses the app as it ships calls.
  '/api/admin/scanner/login',
  '/api/admin/scanner/shipment',
];

export function isScannerDevicePath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return SCANNER_DEVICE_PATHS.includes(path);
}

const SCANNER_OPTIONS = {
  origin: true,
  credentials: false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['authorization', 'content-type'],
  maxAge: 86_400,
} as const;

/**
 * The CORS options, chosen per request: the scanner device routes' open policy above, and the
 * exact-origin, credentialed policy everywhere else.
 */
export function corsOptions(policy: OriginPolicy) {
  const credentialed = credentialedOptions(policy);
  return {
    delegator: (
      request: { readonly url?: string },
      callback: (error: Error | null, options: object) => void,
    ) => {
      callback(null, isScannerDevicePath(request.url ?? '') ? SCANNER_OPTIONS : credentialed);
    },
  };
}
