/**
 * What the generated client sits on: one `fetch` call, done correctly
 * (architecture §23, §25).
 *
 * Hand-written, unlike `src/generated/*`, because the interesting parts are not
 * derivable from an OpenAPI document — they are facts about *this* API that a
 * caller gets wrong in the same four ways every time:
 *
 * 1. **Cookies.** The session is a cookie on a parent domain, and the console,
 *    the portal and the POS all call cross-origin. Without
 *    `credentials: 'include'` the cookie is simply never sent and every request
 *    looks anonymous — which presents as "the API keeps logging me out".
 * 2. **CSRF.** Mutations carry a double-submit token in a header. Forgetting it
 *    fails only mutations, so it is discovered after the read paths are built.
 * 3. **problem+json.** A failure is an RFC 9457 body with a stable `code`, and a
 *    client that reads `.message` gets `undefined`. `ApiProblemError` puts the
 *    code where a caller will find it.
 * 4. **Idempotency.** The header exists and the retry story depends on it.
 */

export interface ApiRuntime {
  /**
   * Where the API lives, e.g. `https://api.erp.example.com`. No trailing slash
   * required; one is tolerated.
   */
  readonly baseUrl: string;
  /**
   * Injected so tests can pass a fake and Node can pass an agent-bound fetch.
   * Defaults to the global.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The CSRF token to echo, read at call time rather than captured, because the
   * cookie is rotated and a token captured at construction goes stale.
   */
  readonly csrfToken?: () => string | undefined;
}

export interface RequestOptions {
  /**
   * An `Idempotency-Key` for this call.
   *
   * Generate one per user intent, not per attempt: the whole mechanism depends
   * on a retry sending the *same* key. `crypto.randomUUID()` at the moment the
   * operator presses the button is the shape that works.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  /** Extra headers. Cannot override the ones this runtime sets deliberately. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface OperationDescriptor {
  readonly method: string;
  /** With `{name}` placeholders, as the OpenAPI document writes them. */
  readonly path: string;
  readonly ability: string | null;
}

export interface OperationInput {
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

/** A failure the API described. */
export class ApiProblemError extends Error {
  constructor(
    readonly status: number,
    /**
     * The stable code. Typed `string`, not `ErrorCode`: the API may answer with a
     * code this build of the client has never heard of, and narrowing that to a
     * closed union here would be a lie a caller could not check.
     */
    readonly code: string,
    readonly detail: string,
    readonly problemType: string,
    readonly fieldErrors: readonly { readonly path: string; readonly message: string }[] = [],
  ) {
    // The message is for a developer reading a stack; `detail` is the one a UI
    // shows, after i18n. Putting the code in the message means a Sentry issue is
    // grouped by the thing that actually distinguishes two failures.
    super(`${code} (${String(status)}): ${detail}`);
    this.name = 'ApiProblemError';
  }
}

/** A failure the API did not describe: offline, DNS, a proxy's HTML error page. */
export class ApiTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    // Through `super`, not a parameter property: `Error.cause` already exists, so
    // declaring it here would shadow the built-in and lose the chaining that
    // makes a DNS failure legible three frames up.
    super(message, { cause });
    this.name = 'ApiTransportError';
  }
}

const MUTATIONS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export async function request(
  runtime: ApiRuntime,
  operation: OperationDescriptor,
  input?: OperationInput,
  options?: RequestOptions,
): Promise<unknown> {
  const url = buildUrl(runtime.baseUrl, operation.path, input);
  const isMutation = MUTATIONS.includes(operation.method);

  const headers: Record<string, string> = { accept: 'application/json' };
  // Caller headers first, so the ones below cannot be overridden: a caller who
  // sets their own `content-type` to `text/plain` would make the server refuse
  // the body, and that is a confusing failure to trace from the browser.
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  if (input?.body !== undefined) headers['content-type'] = 'application/json';

  if (isMutation) {
    const token = runtime.csrfToken?.();
    if (token !== undefined && token !== '') headers['x-csrf-token'] = token;
  }

  if (options?.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }

  const doFetch = runtime.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: operation.method,
      headers,
      // The session is a cookie, and this is the line whose absence looks like
      // the server losing sessions.
      credentials: 'include',
      ...(input?.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new ApiTransportError(`${operation.method} ${operation.path} could not be sent.`, error);
  }

  if (response.status === 204) return undefined;

  const text = await response.text();
  const parsed = text === '' ? undefined : safeJson(text);

  if (!response.ok) throw problemFrom(response.status, parsed);

  if (parsed === undefined && text !== '') {
    // A body that is not JSON on a 2xx means something between here and the API
    // answered instead of the API — a proxy's error page, most often. Saying so
    // beats handing the caller a parse error from deep inside their own code.
    throw new ApiTransportError(
      `${operation.method} ${operation.path} returned a non-JSON body with status ${String(response.status)}.`,
    );
  }

  return parsed;
}

function problemFrom(status: number, body: unknown): ApiProblemError {
  if (typeof body !== 'object' || body === null) {
    return new ApiProblemError(
      status,
      'INTERNAL_ERROR',
      'The API returned no problem details.',
      '',
    );
  }

  const record = body as Record<string, unknown>;
  const errors = Array.isArray(record.errors)
    ? record.errors.filter(isFieldError)
    : ([] as { path: string; message: string }[]);

  return new ApiProblemError(
    typeof record.status === 'number' ? record.status : status,
    typeof record.code === 'string' ? record.code : 'INTERNAL_ERROR',
    typeof record.detail === 'string' ? record.detail : '',
    typeof record.type === 'string' ? record.type : '',
    errors,
  );
}

function isFieldError(value: unknown): value is { path: string; message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.path === 'string' && typeof record.message === 'string';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Substitute the path parameters and append the query string.
 *
 * `encodeURIComponent` on every value, including path parameters. An id with a
 * `/` or a `?` in it would otherwise change which route is called — and one of
 * these ids is Better Auth's text user id, which is not a uuid and so is not
 * guaranteed to be free of them.
 */
export function buildUrl(baseUrl: string, template: string, input?: OperationInput): string {
  const path = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = input?.path?.[name];
    if (value === undefined) {
      throw new ApiTransportError(`Missing path parameter "${name}" for ${template}.`);
    }
    return encodeURIComponent(value);
  });

  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input?.query ?? {})) {
    // An absent filter must not become `?to=undefined`, which the server would
    // reject as a malformed date rather than treating as absent.
    if (value !== undefined) query.append(name, value);
  }

  const search = query.toString();
  return `${baseUrl.replace(/\/$/, '')}${path}${search === '' ? '' : `?${search}`}`;
}
