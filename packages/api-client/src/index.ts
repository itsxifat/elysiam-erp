/**
 * @elysium/api-client
 *
 * The typed client for the ERP's HTTP surface (architecture §4, §23).
 *
 * `src/generated/*` is emitted from `openapi.json` by `pnpm api:client`, which
 * itself generates that document from the Zod contracts and from the routes the
 * API really registers. `pnpm check:api-client` fails the build when the
 * committed copy and a fresh generation disagree, so a route added without
 * regenerating is caught at commit time rather than by a frontend developer
 * calling a method that does not exist.
 *
 * `runtime.ts` is hand-written: cookies, CSRF, problem+json and the
 * `Idempotency-Key` header are facts about this API that no OpenAPI document
 * states, and they are the four things a caller otherwise gets wrong.
 *
 * TanStack Query hooks land with the console shell in M05, on top of this.
 */
export const PACKAGE_NAME = '@elysium/api-client' as const;

export {
  createApiClient,
  OPERATIONS,
  type ApiClient,
  type OperationName,
} from './generated/index.js';

export {
  ApiProblemError,
  ApiTransportError,
  buildUrl,
  request,
  type ApiRuntime,
  type OperationDescriptor,
  type OperationInput,
  type RequestOptions,
} from './runtime.js';
