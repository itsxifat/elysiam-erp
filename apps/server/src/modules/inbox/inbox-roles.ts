/**
 * Who may hold a conversation: the two roles that answer the inbox (D-736). Its own file so the
 * conversations and the auto-offer (D-748) share it without importing each other.
 */
export const INBOX_ROLES = ['sales', 'org_admin'] as const;

/** Whether a role is one of `INBOX_ROLES`. */
export function holdsInboxRole(roles: readonly string[]): boolean {
  return roles.some((role) => (INBOX_ROLES as readonly string[]).includes(role));
}
