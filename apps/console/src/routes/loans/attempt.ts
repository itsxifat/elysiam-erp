/**
 * The client id for one attempt at a create: the same values send the same id, so a retry
 * after a lost response is answered from what the first request wrote; different values,
 * or a cleared attempt after a success, mint a new one.
 */
/**
 * Whether an error ends the attempt. A 4xx is the server's answer about these values — a
 * retry with the same id would only get the same answer (or, for a repayment rejected
 * meanwhile, "pay again with a new id") — so the next submit starts afresh. A lost
 * response or a server fault keeps the id, so the retry is answered from the first write.
 */
export function endsAttempt(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export function attemptId(
  attempt: { current: { readonly key: string; readonly id: string } | null },
  values: unknown,
): string {
  const key = JSON.stringify(values);
  if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
  return attempt.current.id;
}
