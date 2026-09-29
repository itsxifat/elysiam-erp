import { useNavigate, useSearch, type Link } from '@tanstack/react-router';
import type { ComponentProps } from 'react';
import type { z } from 'zod';

/**
 * An orders path, as the router will know it — and the URL search, read and written.
 *
 * TanStack derives `to`'s type and each route's search type from the **live route tree**, so
 * until the integrator wires `ordersRoutes()` into `router.tsx` the desk, the queue, the
 * detail and the buyer list are not in that union, and every typed `<Link>` or
 * `getRouteApi()` in this module is a type error for a reason that has nothing to do with
 * the module. M19's `hrPath` set the precedent: one named widening, in one place.
 *
 * The search is read with `strict: false` and parsed with the route's own schema, so the
 * screen sees exactly what `validateSearch` would have given it; once the routes are
 * registered the router validates the same schema first and this parse is a no-op.
 */
export type OrdersPath = ComponentProps<typeof Link>['to'];

export const ordersPath = (path: string): OrdersPath => path;

export function useSchemaSearch<TSchema extends z.ZodType>(
  schema: TSchema,
): [z.infer<TSchema>, (next: z.infer<TSchema>) => void] {
  const raw: unknown = useSearch({ strict: false });
  const navigate = useNavigate();
  const parsed: z.infer<TSchema> = schema.parse(raw ?? {});
  const set = (next: z.infer<TSchema>) => {
    void navigate({
      to: '.',
      // The route's own `validateSearch` checks this on arrival; see the file comment.
      search: next as never,
      replace: true,
    });
  };
  return [parsed, set];
}
