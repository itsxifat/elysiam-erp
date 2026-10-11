import { useEffect, useState } from 'react';

/**
 * The time, refreshed every `everyMs` (M41: due call-backs and offer countdowns). Read through
 * state rather than `Date.now()` during render, so a render is a function of its inputs.
 */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}
