import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Monogram,
} from '@elysium/ui';
import { useNavigate } from '@tanstack/react-router';
import { LogOut, UserRound } from 'lucide-react';

import { endpoints } from '../api.js';
import { clearBrand } from '../brand.js';
import { useSession } from '../auth/session.js';
import { useT } from '../i18n/locale.js';
import { useProfile } from './profile.js';

/**
 * The account menu (D-449): who you are, in which roles, My account (M40) and Sign out.
 *
 * Its own chunk, like the inbox: the menu's positioning is the cost, and the shell's
 * first paint does not need it. Until it lands the topbar shows the same monogram,
 * inert (`AccountMenuFallback`), so nothing moves when it does.
 */
export function AccountMenu() {
  const t = useT();
  const session = useSession();
  const profile = useProfile();
  const navigate = useNavigate();
  const label = profile.name ?? profile.email ?? t('shell.userMenu');

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('shell.userMenu')}
          className="flex size-8 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
        >
          <Monogram name={label} size="md" className="rounded-full" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-64">
        <MenuLabel className="pt-2 pb-2">
          <span className="block text-xs font-normal text-muted-foreground">
            {t('shell.signedInAs')}
          </span>
          <span className="block truncate text-sm font-medium text-popover-foreground">
            {label}
          </span>
          {profile.email !== null && profile.name !== null ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {profile.email}
            </span>
          ) : null}
          {session.roles.length === 0 ? null : (
            <span className="mt-1.5 block truncate text-xs font-normal text-muted-foreground">
              {session.roles.join(', ')}
            </span>
          )}
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => void navigate({ to: '/account' })}>
          <UserRound aria-hidden="true" />
          {t('shell.myAccount')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={() => {
            void endpoints.signOut().finally(() => {
              clearBrand();
              // A full reload rather than a client-side route change: signing out
              // has to drop every cached query, the socket and the ability, and
              // reconstructing all of that by hand is how a stale org's rows end
              // up on the login screen's successor.
              window.location.reload();
            });
          }}
        >
          <LogOut aria-hidden="true" />
          {t('auth.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
