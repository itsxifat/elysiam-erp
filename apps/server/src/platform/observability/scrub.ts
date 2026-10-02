import { maskPhonesInText, redact } from '@elysium/domain';

import { safeUrl } from '../logging/logger.js';

/**
 * What an error event or a span may carry off the machine (§25, invariant 10).
 *
 * Sentry and the OTLP collector are third parties, so they get what the logs get and no
 * more: no cookies, headers, bodies, query strings or user, no credential-named field, and
 * every Bangladeshi mobile number masked (`017******89`). Both scrubbers are pure and
 * tested; `sentry.ts` and `telemetry.ts` only wire them in.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An error event, scrubbed, or `null` to drop it.
 *
 * The whole event is masked as text — message, exception values, stack frames, tags,
 * contexts — because a driver error quotes the row it refused and that row can hold a
 * phone anywhere. `sdkProcessingMetadata` is the SDK's own bookkeeping, never sent, and
 * can hold live objects that do not serialize, so it is set aside and put back. An event
 * that cannot be scrubbed is dropped: losing one report is better than leaking one.
 */
export function scrubErrorEvent<T extends object>(event: T): T | null {
  try {
    const { sdkProcessingMetadata, ...rest } = event as Record<string, unknown>;
    const copy = JSON.parse(maskPhonesInText(JSON.stringify(rest))) as Record<string, unknown>;

    const request = copy.request;
    if (isRecord(request)) {
      copy.request = {
        ...(typeof request.method === 'string' ? { method: request.method } : {}),
        ...(typeof request.url === 'string' ? { url: safeUrl(request.url) } : {}),
      };
    }
    delete copy.user;
    delete copy.breadcrumbs;
    for (const key of ['extra', 'contexts', 'tags'] as const) {
      if (key in copy) copy[key] = redact(copy[key]);
    }

    if (sdkProcessingMetadata !== undefined) copy.sdkProcessingMetadata = sdkProcessingMetadata;
    return copy as T;
  } catch {
    return null;
  }
}

/** The span attributes that hold a URL, under the old and the stable HTTP conventions. */
const URL_ATTRIBUTES = ['http.target', 'http.url', 'url.full', 'url.path'] as const;

/** A span as the HTTP instrumentations' hooks receive it: the SDK's span, attributes readable. */
export interface ScrubbableSpan {
  readonly attributes?: Readonly<Record<string, unknown>>;
  setAttribute(key: string, value: string): unknown;
}

/**
 * Rewrite a span's URL attributes the way a log line's URL is written: the path with
 * phones masked, the query string replaced by `[redacted]`.
 *
 * Called from the request hooks of the http and undici instrumentations, which run after
 * the span has its attributes. The instrumentation's own redaction is a list of query
 * parameter names (`sig`, `X-Amz-Signature`, …); a phone search (`?q=017…`), a reset
 * `?token=` and a courier's `?api_key=` are not on it, and a phone in a path segment is
 * not a parameter at all.
 */
export function scrubSpanUrls(span: ScrubbableSpan): void {
  const attributes = span.attributes ?? {};
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string') span.setAttribute(key, safeUrl(value));
  }
  if (typeof attributes['url.query'] === 'string') span.setAttribute('url.query', '[redacted]');
}
