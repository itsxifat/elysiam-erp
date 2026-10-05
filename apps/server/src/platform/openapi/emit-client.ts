/**
 * The typed client, emitted from the OpenAPI document (architecture §23).
 *
 * ## Why a small emitter rather than `openapi-typescript` and friends
 *
 * Two reasons, and the second is the one that decided it.
 *
 * The generators in that family turn JSON Schema back into TypeScript, and that
 * round trip *loses* exactly what this codebase cares about. `positivePoishaSchema`
 * is a string with a regex and a range check; through JSON Schema and back it is
 * `string`, and a client would then happily send `"-5"` or a float. Emitting
 * `import type { CashInInput } from '@elysium/contracts'` instead keeps the
 * server's own inferred type, so the frontend and the server are typed by one
 * definition — which is what §23 means by the contracts being the source.
 *
 * And their output is not stable across versions: a patch release reorders
 * members or rewords a comment, the committed client no longer matches a fresh
 * generation, and `pnpm verify` fails on a day nobody touched the API. The drift
 * check is only worth having if a failure means something, so the generator has
 * to be ours.
 *
 * Everything here is deterministic: operations sorted by operationId, imports
 * sorted, no timestamps. A generated file with a date in it can never pass a
 * byte-for-byte comparison, which is the mistake this file exists not to make.
 */

type JsonObject = Readonly<Record<string, unknown>>;

interface ParameterSpec {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly $ref?: string;
  readonly schema?: JsonObject;
}

interface OperationDescription {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  readonly ability: string | null;
  readonly pathParams: readonly string[];
  readonly query: readonly { readonly name: string; readonly required: boolean }[];
  /** The contract type for the body, or null for "no body" / "untyped body". */
  readonly bodyType: string | null;
  readonly hasBody: boolean;
}

/** Read the operations out of the document, in a stable order. */
export function readOperations(document: JsonObject): OperationDescription[] {
  const paths = (document.paths ?? {}) as Record<string, Record<string, JsonObject>>;
  const operations: OperationDescription[] = [];

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const parameters = (operation.parameters ?? []) as ParameterSpec[];
      const body = operation.requestBody as JsonObject | undefined;
      const bodyType = body?.['x-body-type'];

      operations.push({
        operationId: String(operation.operationId),
        method: method.toUpperCase(),
        path,
        summary: typeof operation.summary === 'string' ? operation.summary : '',
        ability: typeof operation['x-ability'] === 'string' ? operation['x-ability'] : null,
        pathParams: parameters.filter((p) => p.in === 'path').map((p) => p.name),
        query: parameters
          .filter((p) => p.in === 'query')
          .map((p) => ({ name: p.name, required: p.required === true })),
        bodyType: typeof bodyType === 'string' ? bodyType : null,
        hasBody: body !== undefined,
      });
    }
  }

  return operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

const HEADER = `/*
 * GENERATED FILE. Do not edit.
 *
 * Emitted from openapi.json by \`pnpm api:client\`. \`pnpm check:api-client\`
 * regenerates it into a scratch directory and fails the build if this copy
 * differs by a single byte, so an edit here is reverted by the next commit that
 * runs verify — change the contracts or the operation catalog instead.
 */
`;

/**
 * Emit `src/generated/client.ts`.
 *
 * One function returning an object of arrow functions rather than a class: it
 * tree-shakes, it needs no \`this\`, and \`ApiClient\` can then be
 * \`ReturnType<typeof createApiClient>\` so the type cannot drift from the
 * implementation.
 */
export function emitClient(document: JsonObject): string {
  const operations = readOperations(document);
  const contractTypes = [
    ...new Set(operations.map((operation) => operation.bodyType).filter(isString)),
  ].sort();

  const lines: string[] = [HEADER];

  if (contractTypes.length > 0) {
    lines.push(`import type { ${contractTypes.join(', ')} } from '@elysium/contracts';`, '');
  }
  lines.push(
    "import { request, type ApiRuntime, type RequestOptions } from '../runtime.js';",
    '',
    '/** Every operation, with the ability its route declares (§6). */',
    'export const OPERATIONS = {',
  );

  for (const operation of operations) {
    lines.push(
      `  ${operation.operationId}: { method: '${operation.method}', path: '${operation.path}', ability: ${
        operation.ability === null ? 'null' : `'${operation.ability}'`
      } },`,
    );
  }

  lines.push(
    '} as const;',
    '',
    'export type OperationName = keyof typeof OPERATIONS;',
    '',
    '/**',
    ' * The typed client.',
    ' *',
    ' * Return types are `unknown` wherever `packages/contracts` does not yet',
    ' * describe the response. That is deliberate: a made-up response type would be',
    ' * relied on by a frontend and would fail at runtime rather than at compile',
    ' * time (follow-up F-M04-1).',
    ' */',
    'export function createApiClient(runtime: ApiRuntime) {',
    '  return {',
  );

  for (const operation of operations) {
    const input = inputType(operation);
    const signature =
      input === null ? '(options?: RequestOptions)' : `(input: ${input}, options?: RequestOptions)`;
    const call = input === null ? 'undefined' : 'input';

    if (operation.summary !== '') lines.push(`    /** ${operation.summary} */`);
    lines.push(
      `    ${operation.operationId}: ${signature}: Promise<unknown> =>`,
      `      request(runtime, OPERATIONS.${operation.operationId}, ${call}, options),`,
    );
  }

  lines.push('  };', '}', '', 'export type ApiClient = ReturnType<typeof createApiClient>;', '');

  return lines.join('\n');
}

/**
 * The single argument object for an operation, or null when it takes none.
 *
 * One object with `path`, `query` and `body` members rather than three
 * positional arguments: positional arguments change meaning when an operation
 * gains a query parameter, and a silent change of meaning in a generated client
 * is the worst kind — it compiles.
 */
function inputType(operation: OperationDescription): string | null {
  const members: string[] = [];

  if (operation.pathParams.length > 0) {
    const fields = [...operation.pathParams]
      .sort()
      .map((name) => `readonly ${name}: string`)
      .join('; ');
    members.push(`readonly path: { ${fields} }`);
  }

  if (operation.query.length > 0) {
    const fields = [...operation.query]
      .sort((a, b) => a.name.localeCompare(b.name))
      // Everything in a query string is a string on the wire. Typing a page size
      // as `number` here would be a lie the runtime has to launder.
      .map((parameter) => `readonly ${parameter.name}${parameter.required ? '' : '?'}: string`)
      .join('; ');
    const allOptional = operation.query.every((parameter) => !parameter.required);
    members.push(`readonly query${allOptional ? '?' : ''}: { ${fields} }`);
  }

  if (operation.hasBody) {
    members.push(`readonly body: ${operation.bodyType ?? 'unknown'}`);
  }

  return members.length === 0 ? null : `{ ${members.join('; ')} }`;
}

function isString(value: string | null): value is string {
  return value !== null;
}

/** Emit `src/generated/index.ts`, the package's public surface. */
export function emitIndex(): string {
  return [
    HEADER,
    "export { createApiClient, OPERATIONS, type ApiClient, type OperationName } from './client.js';",
    '',
  ].join('\n');
}
