import type { MeWire } from '@elysium/mother-shared';
import { createContext, useContext } from 'react';

/** The signed-in owner, resolved once by the app's boot and read by the shell. */
export const SessionContext = createContext<MeWire | null>(null);

export function useMe(): MeWire {
  const me = useContext(SessionContext);
  if (me === null) throw new Error('useMe needs a signed-in session above it.');
  return me;
}
