/**
 * Which new inbox messages ring for whom (M44a, D-764, D-766): pure, so it is tested without a
 * browser or an API.
 */

/** Whether a new message is one for this person to hear. Pure, for the test. */
export function messageConcerns(
  payload: unknown,
  me: string | null,
  takesMessages: boolean,
): { readonly conversationId: string; readonly channel: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.conversationId !== 'string') return null;
  if (body.direction === 'outbound') return null;
  const assignedTo = typeof body.assignedTo === 'string' ? body.assignedTo : null;
  const mine = assignedTo !== null && assignedTo === me;
  if (!mine && !(assignedTo === null && takesMessages)) return null;
  return {
    conversationId: body.conversationId,
    channel: typeof body.channel === 'string' ? body.channel : '',
  };
}
