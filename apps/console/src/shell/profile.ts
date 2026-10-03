import { useQuery } from '@tanstack/react-query';

import { api } from '../api.js';

/**
 * Who is signed in, by name: for the account menu's monogram and the overview's
 * greeting.
 *
 * The session context (`/v1/me`) carries ids and roles and deliberately no personal
 * data, so the name comes from Better Auth's own session read. Optional by design: if
 * it fails, the menu shows a generic mark and the greeting drops the name. Nothing
 * waits on it and nothing breaks without it.
 */
interface AuthSession {
  readonly user?: { readonly name?: string | null; readonly email?: string | null } | null;
}

export interface Profile {
  readonly name: string | null;
  readonly email: string | null;
}

export function useProfile(): Profile {
  const query = useQuery({
    queryKey: ['auth-profile'],
    queryFn: () => api.get<AuthSession | null>('/api/auth/get-session'),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const user = query.data?.user ?? null;
  const name = typeof user?.name === 'string' && user.name.trim() !== '' ? user.name.trim() : null;
  const email = typeof user?.email === 'string' && user.email !== '' ? user.email : null;
  return { name, email };
}
