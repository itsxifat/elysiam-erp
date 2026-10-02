/**
 * The client id for one attempt at a create: the same values send the same id, so a retry
 * after a lost response is answered from what the first request wrote; different values,
 * or a cleared attempt after a success, mint a new one.
 */
export function attemptId(
  attempt: { current: { readonly key: string; readonly id: string } | null },
  values: unknown,
): string {
  const key = JSON.stringify(values);
  if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
  return attempt.current.id;
}
