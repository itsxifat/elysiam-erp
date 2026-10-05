import { describe, expect, it } from 'vitest';

import { OPERATION_CATALOG } from './catalog.js';
import {
  buildOpenApiDocument,
  fallbackOperationId,
  pathParameters,
  tagFor,
  toOpenApiPath,
  type RouteInput,
} from './document.js';
import { emitClient, readOperations } from './emit-client.js';

const ROUTES: readonly RouteInput[] = [
  { method: 'GET', path: '/health/live', declared: 'public:Liveness probes need no session.' },
  { method: 'POST', path: '/v1/ledger/cash-in', declared: 'update:Wallet' },
  { method: 'GET', path: '/v1/ledger/accounts/:id/ledger', declared: 'read:LedgerReport' },
  { method: 'GET', path: '/v1/ledger/trial-balance', declared: 'read:LedgerReport' },
  { method: 'OPTIONS', path: '/v1/anything', declared: null },
];

type Json = Record<string, unknown>;

function document(): Json {
  return buildOpenApiDocument({ routes: ROUTES, version: '1.0.0' });
}

function operation(path: string, method: string): Json {
  const paths = document().paths as Record<string, Record<string, Json>>;
  const found = paths[path]?.[method];
  if (found === undefined) throw new Error(`no ${method} ${path} in the document`);
  return found;
}

describe('the OpenAPI document (§23)', () => {
  it('declares OpenAPI 3.1, whose schema dialect is the one Zod emits', () => {
    expect(document().openapi).toBe('3.1.0');
  });

  it('rewrites Nest path parameters into OpenAPI ones', () => {
    expect(toOpenApiPath('/v1/ledger/accounts/:id/ledger')).toBe('/v1/ledger/accounts/{id}/ledger');
    expect(pathParameters('/v1/orders/:orderId/lines/:lineId')).toEqual(['orderId', 'lineId']);
    expect(Object.keys(document().paths as Json)).toContain('/v1/ledger/accounts/{id}/ledger');
  });

  it('leaves out the methods that answer nothing', () => {
    // An OPTIONS handler is CORS plumbing; a client method for it would do
    // nothing and would still have to be maintained.
    expect(Object.keys(document().paths as Json)).not.toContain('/v1/anything');
  });

  it('publishes the request schema the server actually validates with', () => {
    const body = operation('/v1/ledger/cash-in', 'post').requestBody as Json;
    expect(body.required).toBe(true);
    const content = body.content as Record<string, Json>;
    expect(content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/CashIn',
    });

    const schemas = (document().components as Json).schemas as Record<string, Json>;
    const cashIn = schemas.CashIn;
    expect(cashIn?.required).toEqual(
      expect.arrayContaining(['entryId', 'walletAccountId', 'incomeAccountId', 'amountPoisha']),
    );
    // Money is a decimal string on the wire (invariant 1). If this ever becomes
    // `number`, a generated client will round 16 digits through a float.
    const properties = cashIn?.properties as Record<string, Json>;
    expect(properties.amountPoisha?.type).toBe('string');
  });

  it('flattens a query schema into query parameters, not one object parameter', () => {
    // `?query={"to":"…"}` would be refused by the server, so a document that
    // described the object would describe a request that does not work.
    const parameters = operation('/v1/ledger/trial-balance', 'get').parameters as Json[];
    expect(parameters).toEqual([
      {
        name: 'asOf',
        in: 'query',
        required: true,
        schema: expect.objectContaining({ type: 'string' }) as unknown,
      },
    ]);
  });

  it('marks an optional query member optional', () => {
    const parameters = operation('/v1/ledger/accounts/{id}/ledger', 'get').parameters as Json[];
    const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
    expect(byName.get('from')?.required).toBe(false);
    expect(byName.get('to')?.required).toBe(true);
    // The path parameter is required and comes first.
    expect(parameters[0]?.name).toBe('id');
  });

  it('offers Idempotency-Key on mutations and only on mutations', () => {
    const post = operation('/v1/ledger/cash-in', 'post').parameters as Json[];
    expect(post).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });

    const get = operation('/v1/ledger/trial-balance', 'get').parameters as Json[];
    expect(get).not.toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
  });

  it('describes failures as problem+json, with the codes enumerated', () => {
    const responses = operation('/v1/ledger/cash-in', 'post').responses as Record<string, Json>;
    const conflict = responses['409']?.content as Record<string, Json>;
    expect(conflict['application/problem+json']?.schema).toEqual({
      $ref: '#/components/schemas/Problem',
    });

    const schemas = (document().components as Json).schemas as Record<string, Json>;
    const code = (schemas.Problem?.properties as Record<string, Json>).code;
    expect(code?.enum).toContain('PERIOD_CLOSED');
    expect(code?.enum).toContain('IDEMPOTENCY_IN_FLIGHT');
  });

  it('exempts a public route from the session requirement, and nothing else', () => {
    expect(operation('/health/live', 'get').security).toEqual([]);
    expect(operation('/v1/ledger/cash-in', 'post')).not.toHaveProperty('security');
    expect(document().security).toEqual([{ session: [] }]);
  });

  it('publishes a bare `public` rather than the reason the route gave', () => {
    // Rewording an internal reason must not change every generated file.
    expect(operation('/health/live', 'get')['x-ability']).toBe('public');
    expect(operation('/v1/ledger/cash-in', 'post')['x-ability']).toBe('update:Wallet');
  });

  it('gives a 404 only where there is a record to be missing', () => {
    const withParam = operation('/v1/ledger/accounts/{id}/ledger', 'get').responses as Json;
    expect(withParam).toHaveProperty('404');
    const withoutParam = operation('/v1/ledger/trial-balance', 'get').responses as Json;
    expect(withoutParam).not.toHaveProperty('404');
  });

  it('is byte-identical when built twice, which is what the drift check needs', () => {
    expect(JSON.stringify(document())).toBe(JSON.stringify(document()));
  });

  it('is insensitive to the order Nest happened to report routes in', () => {
    const shuffled = [...ROUTES].reverse();
    expect(JSON.stringify(buildOpenApiDocument({ routes: shuffled, version: '1.0.0' }))).toBe(
      JSON.stringify(document()),
    );
  });

  it('documents a route the catalog has never heard of, with a stable name', () => {
    const surprise: RouteInput[] = [
      { method: 'POST', path: '/v1/files/uploads', declared: 'create:File' },
    ];
    const built = buildOpenApiDocument({ routes: surprise, version: '1.0.0' });
    const paths = built.paths as Record<string, Record<string, Json>>;
    // Ugly on purpose: it nudges somebody to add a catalog entry, and it is
    // stable, so the drift check does not thrash in the meantime.
    expect(paths['/v1/files/uploads']?.post?.operationId).toBe('postV1FilesUploads');
    expect(fallbackOperationId({ method: 'GET', path: '/v1/orders/:id', declared: null })).toBe(
      'getV1OrdersById',
    );
  });

  it('groups operations by the segment after the version', () => {
    expect(tagFor('/v1/ledger/cash-in')).toBe('ledger');
    expect(tagFor('/health/live')).toBe('health');
    expect(document().tags).toEqual([{ name: 'health' }, { name: 'ledger' }]);
  });

  it('has an operationId for every catalog entry, and no duplicates', () => {
    const ids = Object.values(OPERATION_CATALOG).map((spec) => spec.operationId);
    // A duplicate would silently overwrite a method in the generated client.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the emitted client', () => {
  it('reads every operation out of the document it was given', () => {
    const operations = readOperations(document());
    expect(operations.map((entry) => entry.operationId)).toEqual([
      'accountLedger',
      'cashIn',
      'healthLive',
      'trialBalance',
    ]);
  });

  it("types a body as the contract's own type rather than re-deriving it", () => {
    // Round-tripping through JSON Schema would turn a poisha string into
    // `string`, losing the regex and the range check.
    const source = emitClient(document());
    expect(source).toContain("import type { CashInInput } from '@elysium/contracts';");
    expect(source).toContain('readonly body: CashInInput');
  });

  it('makes a query object optional when every member is', () => {
    const source = emitClient(document());
    expect(source).toContain('readonly query: { readonly from?: string; readonly to: string }');
  });

  it('takes no argument at all when an operation has no inputs', () => {
    expect(emitClient(document())).toContain('healthLive: (options?: RequestOptions)');
  });

  it('carries no timestamp, so a regeneration can be compared byte-for-byte', () => {
    expect(emitClient(document())).toBe(emitClient(document()));
    expect(emitClient(document())).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
