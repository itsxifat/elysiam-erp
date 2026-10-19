import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, type RefObject } from 'react';

import { pickProducts, SELL_KEY, type PickerProduct } from './sell-api.js';

/**
 * Every product for what was typed, a page at a time (M49, D-890): many products share a name, so
 * the agent scrolls through all of them rather than seeing the first few. Its own cache key: the
 * side card's one-product lookups (`[…SELL_KEY, 'pick', …]`) hold a different shape.
 */
export function useProductSearch(term: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: [...SELL_KEY, 'search', term],
    queryFn: ({ pageParam }) => pickProducts({ q: term, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const items: readonly PickerProduct[] = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  return { ...query, items };
}

/**
 * Ask for the next page when `sentinel` scrolls into `root` (or comes within a row of it): the
 * results' own scroll area, not the page's.
 */
export function useLoadMore(
  root: RefObject<HTMLElement | null>,
  sentinel: RefObject<HTMLElement | null>,
  next: () => void,
  active: boolean,
): void {
  useEffect(() => {
    const target = sentinel.current;
    if (!active || target === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) next();
      },
      { root: root.current, rootMargin: '0px 0px 120px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [root, sentinel, next, active]);
}
