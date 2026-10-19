import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api } from './api.js';
import { useT } from './i18n/locale.js';

/**
 * The names behind the staff ids a record carries (D-898): who took an order, wrote a note,
 * asked for an approval, printed a label. A record keeps a person's id and a screen shows their
 * name, never the id, whether they still work here, are a super admin or have left.
 *
 * Each id is its own query, so a name read once serves every screen; the ids asked for in one
 * tick go to `GET /v1/staff-names` together.
 */

interface StaffName {
  readonly userId: string;
  readonly name: string | null;
  /** An owner, named only to another owner (D-473). */
  readonly owner: boolean;
}

/** A person's id; a channel's or a worker's actor (`intake:…`, `system:…`) names nobody. */
const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PER_CALL = 200;

let waiting: {
  readonly ids: Set<string>;
  readonly answer: Promise<ReadonlyMap<string, StaffName>>;
} | null = null;

async function fetchNames(ids: readonly string[]): Promise<ReadonlyMap<string, StaffName>> {
  const found = new Map<string, StaffName>();
  for (let start = 0; start < ids.length; start += PER_CALL) {
    const query = new URLSearchParams({ ids: ids.slice(start, start + PER_CALL).join(',') });
    const answer = await api.get<{ people: StaffName[] }>(`/v1/staff-names?${query.toString()}`);
    for (const person of answer.people) found.set(person.userId, person);
  }
  return found;
}

function load(id: string): Promise<StaffName> {
  if (waiting === null) {
    const ids = new Set<string>();
    const answer = new Promise<ReadonlyMap<string, StaffName>>((resolve, reject) => {
      setTimeout(() => {
        waiting = null;
        fetchNames([...ids]).then(resolve, reject);
      }, 0);
    });
    waiting = { ids, answer };
  }
  waiting.ids.add(id);
  return waiting.answer.then((found) => found.get(id) ?? { userId: id, name: null, owner: false });
}

const byId = (results: UseQueryResult<StaffName>[]): ReadonlyMap<string, StaffName> =>
  new Map(
    results.flatMap((result) =>
      result.data === undefined ? [] : [[result.data.userId, result.data]],
    ),
  );

/**
 * A name for each staff id a screen shows. The answer is null while it loads and for an id that
 * names nobody here (a channel's actor, a person of no record in this brand): the screen shows
 * its own word for those, never the id.
 */
export function useStaffNames(
  ids: readonly (string | null | undefined)[],
): (id: string | null | undefined) => string | null {
  const t = useT();
  const wanted = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && PERSON_ID.test(id))),
  ];
  const names = useQueries({
    queries: wanted.map((id) => ({
      queryKey: ['staff-name', id],
      queryFn: () => load(id),
      staleTime: 10 * 60_000,
    })),
    combine: byId,
  });
  return useCallback(
    (id: string | null | undefined) => {
      const person = id == null ? undefined : names.get(id);
      if (person === undefined) return null;
      return person.owner && person.name === null ? t('users.owner') : person.name;
    },
    [names, t],
  );
}
