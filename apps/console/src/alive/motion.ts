import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import './alive.css';

/**
 * The live layer's hooks (M44a, D-765): a clock for relative times, the ids that arrived since
 * a list first showed (so only new messages animate, never a whole thread on open), and a FLIP
 * reorder so a conversation that gets a message glides to the top instead of jumping.
 */

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Now, ticking every `everyMs` while the tab is visible: "2 min ago" moves on by itself. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    const timer = window.setInterval(tick, everyMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [everyMs]);
  return now;
}

/**
 * The ids that were not there when the list first rendered. What was on screen at first never
 * counts as new, so opening a thread does not animate its history; one that arrived keeps its
 * entrance class, which plays once, when it mounts.
 */
export function useArrivals(ids: readonly string[]): ReadonlySet<string> {
  const [initial] = useState(() => new Set(ids));
  return useMemo(() => new Set(ids.filter((id) => !initial.has(id))), [ids, initial]);
}

/**
 * FLIP: when the children marked `data-flip-key` change order, each one that moved starts where
 * it was and slides to where it is. Measured before paint, so nothing flashes; skipped under
 * reduced motion.
 */
export function useFlip(container: RefObject<HTMLElement | null>, order: string): void {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    if (root === null) return;
    const items = root.querySelectorAll<HTMLElement>('[data-flip-key]');
    const before = positions.current;
    const after = new Map<string, number>();
    const style = getComputedStyle(root);
    // The kit's own token, never a number of our own: missing, nothing moves.
    const duration = Number.parseInt(style.getPropertyValue('--duration-enter').trim(), 10);
    const easing = style.getPropertyValue('--ease-out').trim();
    const animate =
      !prefersReducedMotion() &&
      before.size > 0 &&
      Number.isFinite(duration) &&
      duration > 0 &&
      easing !== '';
    for (const item of items) {
      const key = item.dataset.flipKey ?? '';
      const top = item.offsetTop;
      after.set(key, top);
      const was = before.get(key);
      if (!animate || was === undefined || was === top || typeof item.animate !== 'function') {
        continue;
      }
      item.animate(
        [{ transform: `translateY(${String(was - top)}px)` }, { transform: 'translateY(0)' }],
        { duration, easing },
      );
    }
    positions.current = after;
  }, [container, order]);
}
