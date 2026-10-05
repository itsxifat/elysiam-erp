import {
  defineAbilityFor,
  effectiveScope,
  uniformBranchScope,
  type Action,
  type AppAbility,
  type MembershipRole,
  type Subject,
} from '@elysium/contracts';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { ApiError, endpoints, type AvailableOrg, type RequestContext } from '../api.js';

/**
 * Who is signed in, in which org, and what they may see (§6, M05 check 1).
 *
 * The ability is built **in the browser from the same `defineAbilityFor` and the
 * same `MATRIX` the server guards with**, which is the whole reason the
 * navigation can be computed rather than listed. A hardcoded sidebar drifts from
 * the matrix the first time a permission changes, and the drift is invisible: the
 * link is still there and it 403s. Reading the matrix means adding a role's
 * access adds its screens, and removing it removes them, with nothing to
 * remember.
 *
 * It is equally important what this is **not**. `.claude/rules/frontend.md`:
 * "Treat the server as the only real permission check." Everything here is
 * computed from data the browser was handed and anybody can edit it. This decides
 * what to *offer*; the route guard, `serializeFor()` and RLS decide what happens.
 */

export interface Session {
  readonly orgs: readonly AvailableOrg[];
  readonly context: RequestContext | null;
  readonly ability: AppAbility;
  readonly roles: readonly MembershipRole[];
  /** Re-read `/v1/me` and everything that depends on it — used after an org switch. */
  readonly refresh: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export const SESSION_QUERY_KEY = ['session'] as const;

interface SessionPayload {
  readonly orgs: readonly AvailableOrg[];
  readonly context: RequestContext | null;
}

/**
 * Resolve the session the way M02a's shell did, because the semantics are
 * subtle: `/v1/me` answers 401 until an org is active, and that is not an error —
 * a fresh session legitimately has none, and a user with exactly one membership
 * is switched into it here rather than shown a chooser with one option.
 */
async function loadSession(): Promise<SessionPayload> {
  const { orgs } = await endpoints.myOrgs();

  let context: RequestContext | null = null;
  try {
    context = await endpoints.me();
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
  }

  if (context === null && orgs.length === 1 && orgs[0] !== undefined) {
    await endpoints.setActiveOrg(orgs[0].orgId);
    context = await endpoints.me();
  }

  return { orgs, context };
}

export function useSessionQuery(): UseQueryResult<SessionPayload> {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: loadSession,
    // The session is the one thing every screen depends on; a stale copy after
    // an org switch would show the previous brand's data under the next brand's
    // name. Refetching on focus is also how a session revoked in another tab
    // stops looking valid here.
    staleTime: 30_000,
    retry: false,
  });
}

export function SessionProvider({
  value,
  children,
}: {
  readonly value: SessionPayload;
  readonly children: ReactNode;
}) {
  const queryClient = useQueryClient();

  const session = useMemo<Session>(() => {
    const roles = (value.context?.roles ?? []) as readonly MembershipRole[];
    const branchIds = value.context?.branchIds ?? [];

    return {
      orgs: value.orgs,
      context: value.context,
      roles,
      ability: defineAbilityFor({
        roles,
        isSuperAdmin: value.context?.isSuperAdmin ?? false,
        userId: value.context?.userId ?? '',
        branchIds,
        /*
         * `/v1/me` reports the union of the caller's branches, not the per-role
         * split that `AbilityContext` wants (D-075). For *navigation* that
         * distinction does not arise — asking "can this caller read Orders at
         * all" ignores the row conditions entirely — so the uniform scope is the
         * honest shape rather than a guess: it says "these roles, these
         * branches", which is exactly as much as the client knows.
         *
         * It would be wrong to rely on it for a row decision, and nothing here
         * does: a row's visibility is the server's answer, arriving as the
         * presence or absence of the row in a response.
         */
        branchIdsByRole: uniformBranchScope(roles, branchIds),
      }),
      refresh: async () => {
        await queryClient.invalidateQueries();
      },
    };
  }, [value, queryClient]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession needs a <SessionProvider> above it.');
  return session;
}

/** The ability alone, which is what the navigation and every gate want. */
export function useAbility(): AppAbility {
  return useSession().ability;
}

/**
 * Whether the caller reaches every row of a subject: a super admin, or a role whose cell for it
 * is `org`. For a screen whose route refuses an `own` or `branch` reach outright (a list of every
 * shopper, M34), so it is not offered to someone it would refuse.
 */
export function useOrgWide(): (action: Action, subject: Subject) => boolean {
  const session = useSession();
  return (action, subject) =>
    session.context?.isSuperAdmin === true ||
    effectiveScope(session.roles, action, subject) === 'org';
}
