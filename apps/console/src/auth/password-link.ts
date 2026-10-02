/**
 * The two link pages an admin's link opens, and the token in its fragment
 * (gaps-users-auth, D-402). Pure, so the console's link builder and this reader can be
 * tested against each other without a browser.
 */

export type PasswordLinkPage = 'invite' | 'reset';

/** Which link page this path is, if any. */
export function passwordLinkPage(pathname: string): PasswordLinkPage | null {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/accept-invite') return 'invite';
  if (path === '/reset-password') return 'reset';
  return null;
}

/** The token from `#token=…`. Anything else in the fragment is ignored. */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token === null || token.trim() === '' ? null : token.trim();
}
