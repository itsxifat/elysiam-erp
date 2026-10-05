import { z } from 'zod';

import {
  OPERATION_CATALOG,
  problemSchema,
  type NamedSchema,
  type OperationSpec,
} from './catalog.js';

/**
 * The OpenAPI 3.1 document, built from the contracts and from the routes the
 * application really registers (architecture §23).
 *
 * ## Why no OpenAPI library
 *
 * Zod 4.6 converts a schema to JSON Schema itself (`z.toJSONSchema`), and
 * OpenAPI 3.1's schema dialect *is* JSON Schema 2020-12 — so the one job a
 * `zod-to-openapi` package would do is already in a dependency we have. Every
 * candidate was also written against Zod 3's internals and would have pinned us
 * behind a major version of the library that every form in the system validates
 * with. A dependency avoided is also a dependency that cannot lag Zod 4.
 *
 * ## Why the routes are an argument
 *
 * The route list comes from Nest's container (`describeRoutes`) at generation
 * time, not from a list in this file. A hand-kept list of routes is a list that
 * is missing the endpoint somebody added on Friday, and an undocumented endpoint
 * is one no generated client can call — so the omission is discovered by a
 * frontend developer rather than by a build. Routes arrive here as data so the
 * builder stays pure and its tests do not need to boot the application.
 *
 * ## Determinism
 *
 * Every object is assembled in sorted order, because the committed
 * `openapi.json` and the committed client are compared byte-for-byte by
 * `check-api-client`. A document whose key order depended on module load order
 * would fail that check at random, and a check that fails at random gets
 * disabled.
 */

/** The parts of a route the document needs. Matches `RouteDeclaration`. */
export interface RouteInput {
  readonly method: string;
  readonly path: string;
  /** `read:Order`, `authenticated`, `public:<reason>`, or null. */
  readonly declared: string | null;
}

export interface OpenApiOptions {
  readonly routes: readonly RouteInput[];
  /** The document version. Bumped by hand when the surface changes shape. */
  readonly version: string;
}

type JsonObject = Record<string, unknown>;

/**
 * The session cookie's name, as Better Auth sets it.
 *
 * Documented so a generated client knows the API is cookie-authenticated rather
 * than bearer-token authenticated — which changes what a caller must do (send
 * credentials, and send the CSRF header on mutations) and is the single thing
 * most often got wrong against this kind of API.
 */
const SESSION_COOKIE = 'better-auth.session_token';

const CSRF_HEADER = 'x-csrf-token';

export function buildOpenApiDocument(options: OpenApiOptions): JsonObject {
  const components = new Map<string, JsonObject>();
  register(components, { name: 'Problem', schema: problemSchema });

  const paths: Record<string, JsonObject> = {};

  for (const route of sortRoutes(options.routes)) {
    // `ALL` and `OPTIONS` handlers are plumbing (CORS preflight, catch-alls);
    // publishing them would put methods in the client that answer nothing.
    if (route.method === 'ALL' || route.method === 'OPTIONS' || route.method === 'HEAD') continue;

    const key = `${route.method} ${route.path}`;
    const spec = OPERATION_CATALOG[key];
    const openApiPath = toOpenApiPath(route.path);

    const operation = buildOperation(route, spec, components);
    paths[openApiPath] = { ...paths[openApiPath], [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      // Neutral on purpose: every brand runs its own copy of this API, and the document may
      // be handed to a brand's website developer (D-472).
      title: 'ERP API',
      version: options.version,
      description:
        'Generated from the shared Zod contracts and the routes the API ' +
        'registers. Do not edit by hand: `pnpm api:client` regenerates it and ' +
        '`pnpm check:api-client` fails the build if the committed copy disagrees.',
    },
    // Relative, so the same document is correct for the console, the portal and
    // the POS, each of which reaches this API on a different host.
    servers: [{ url: '/' }],
    tags: tagsFor(paths),
    security: [{ session: [] }],
    components: {
      securitySchemes: {
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description:
            'Set by Better Auth at sign-in. Mutations additionally require the ' +
            `double-submit token in \`${CSRF_HEADER}\`.`,
        },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description:
            'A client-generated key, 8-255 printable ASCII characters. The response is ' +
            'kept for 24 hours per user and route and replayed on a repeat, so a retry ' +
            'after a lost reply cannot repeat the effect.',
          schema: { type: 'string', minLength: 8, maxLength: 255 },
        },
      },
      schemas: sortObject(Object.fromEntries(components)),
    },
    paths: sortObject(paths),
  };
}

function buildOperation(
  route: RouteInput,
  spec: OperationSpec | undefined,
  components: Map<string, JsonObject>,
): JsonObject {
  const isPublic = route.declared?.startsWith('public:') ?? false;
  const parameters: JsonObject[] = [];

  for (const name of pathParameters(route.path)) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      // Every path parameter in this API is an id, and every id is a uuid apart
      // from the user's, which is Better Auth's text id — so `string` with no
      // format is the honest description rather than a `uuid` that would make a
      // generated validator reject a legitimate call.
      schema: { type: 'string' },
    });
  }

  if (spec?.query !== undefined) {
    parameters.push(...queryParameters(spec.query));
  }

  const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method);
  if (mutation) parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });

  const successStatus = route.method === 'POST' ? '201' : '200';

  return {
    operationId: spec?.operationId ?? fallbackOperationId(route),
    summary: spec?.summary ?? `${route.method} ${route.path}`,
    tags: [tagFor(route.path)],
    /*
     * The ability the guard checks, published as an extension.
     *
     * It costs nothing and it answers the question every integrator asks second
     * — "what role do I need for this" — from the same metadata the guard reads,
     * so the answer cannot be stale. §6's matrix is the authority; this is that
     * authority, printed.
     *
     * A public route publishes the bare word `public`, not `@Public`'s reason.
     * The reason is internal prose that will be reworded, and rewording it would
     * change every generated file and fail the drift check on a commit that
     * changed no API at all — which is how a gate stops being trusted.
     */
    'x-ability': isPublic ? 'public' : route.declared,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(spec?.body === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: reference(register(components, spec.body)) },
            },
            ...(spec.body.type === undefined ? {} : { 'x-body-type': spec.body.type }),
          },
        }),
    responses: {
      [successStatus]: {
        description: 'Success.',
        /*
         * No response schema, and that is a statement rather than an oversight:
         * `packages/contracts` describes what goes *in* and nothing yet
         * describes what comes back. Publishing an invented shape would be worse
         * than publishing none — a generated client would type it, a frontend
         * would rely on it, and the first disagreement would surface as a
         * runtime undefined rather than a type error. Response contracts are
         * per-module work (follow-up F-M04-1).
         */
        content: { 'application/json': { schema: {} } },
      },
      ...(isPublic
        ? {}
        : {
            '401': problemResponse('No session, or the session has expired.'),
            '403': problemResponse('The session has no ability for this route.'),
          }),
      '400': problemResponse('The request failed validation.'),
      ...(pathParameters(route.path).length > 0
        ? { '404': problemResponse('No such record, or none this caller may see.') }
        : {}),
      ...(mutation
        ? {
            '409': problemResponse(
              'A conflict: a closed period, or an Idempotency-Key reused for a different body.',
            ),
          }
        : {}),
      '429': problemResponse('Rate limited. Honour `retry-after`.'),
      '500': problemResponse('An unexpected failure. Already logged; the detail is generic.'),
    },
    ...(isPublic ? { security: [] } : {}),
  };
}

function problemResponse(description: string): JsonObject {
  return {
    description,
    // RFC 9457: the media type is how a client knows the body is problem
    // details rather than the resource it asked for.
    content: { 'application/problem+json': { schema: reference('Problem') } },
  };
}

/**
 * Convert a query object schema into individual query parameters.
 *
 * OpenAPI describes a query string as a list of parameters, not as one object,
 * and a client that sent `?query={"to":"2026-05-31"}` would be refused by the
 * server — so flattening here is what makes the document describe the request
 * that actually works.
 *
 * Everything in a query string arrives as a string, which is why the schemas are
 * converted in `input` mode: `z.coerce.number()` describes a *number* on the way
 * out and a string on the way in, and the wire only ever sees the input side.
 */
function queryParameters(query: NamedSchema): JsonObject[] {
  const json = toJsonSchema(query.schema);
  const properties = (json.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((json.required ?? []) as string[]);

  return Object.keys(properties)
    .sort()
    .map((name) => ({
      name,
      in: 'query',
      required: required.has(name),
      schema: properties[name] ?? {},
    }));
}

/** Add a schema to `components.schemas` and return its name. */
function register(components: Map<string, JsonObject>, entry: NamedSchema): string {
  const existing = components.get(entry.name);
  const json = toJsonSchema(entry.schema);

  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(json)) {
    /*
     * Two different schemas cannot share a component name: the second would
     * silently overwrite the first, and every operation referencing it would
     * then publish the wrong request shape — a client generated from it would
     * send the wrong body and be refused at the edge, which is a confusing
     * failure to debug from the frontend side.
     */
    throw new Error(
      `Two different schemas are both registered as "${entry.name}". Rename one in catalog.ts.`,
    );
  }

  components.set(entry.name, json);
  return entry.name;
}

function reference(name: string): JsonObject {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * Zod to JSON Schema, in input mode and without the `$schema` preamble.
 *
 * `io: 'input'` because a document describes what a *client sends*; the default
 * output mode would publish the post-transform shape, so `z.coerce` and
 * `.transform()` fields would be documented as the type the server ends up with
 * rather than the one it accepts.
 *
 * `$schema` is dropped from each component: OpenAPI 3.1 declares the dialect
 * once for the whole document, and repeating it inside every component is noise
 * that some validators reject.
 */
export function toJsonSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    // A Zod `.refine()` has no JSON Schema equivalent. Failing on it would make
    // every cross-field rule — `from <= to` on a date range — unpublishable;
    // the server still enforces it, and the document describes the shape.
    unrepresentable: 'any',
  }) as JsonObject;

  const { $schema: _dialect, ...rest } = json;
  return rest;
}

/** `/v1/orders/:id` → `/v1/orders/{id}`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function pathParameters(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? '');
}

/**
 * The tag a route is grouped under: the segment after `/v1`, or the first
 * segment when there is no version prefix (`/health`).
 */
export function tagFor(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments[0] === 'v1') return segments[1] ?? 'v1';
  return segments[0] ?? 'root';
}

function tagsFor(paths: Record<string, JsonObject>): JsonObject[] {
  const names = new Set<string>();
  for (const path of Object.keys(paths)) names.add(tagFor(path));
  return [...names].sort().map((name) => ({ name }));
}

/**
 * A name for a route the catalog does not describe.
 *
 * `POST /v1/files/uploads` → `postV1FilesUploads`. Ugly on purpose: an
 * operationId that reads badly in the generated client is the cheapest possible
 * nudge to add a catalog entry, and it is still stable, so the drift check does
 * not thrash while somebody gets round to it.
 */
export function fallbackOperationId(route: RouteInput): string {
  const parts = route.path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => segment.replace(/^:/, 'by-'));

  const camel = [route.method.toLowerCase(), ...parts]
    .join('-')
    .replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) =>
      next === undefined ? '' : next.toUpperCase(),
    );

  return camel;
}

function sortRoutes(routes: readonly RouteInput[]): RouteInput[] {
  return [...routes].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
}

function sortObject<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
