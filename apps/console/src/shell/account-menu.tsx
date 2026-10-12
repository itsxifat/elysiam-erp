import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  Monogram,
} from '@elysium/ui';
import { useNavigate } from '@tanstack/react-router';
import { LogOut, UserRound, Volume2, VolumeX } from 'lucide-react';

import { endpoints } from '../api.js';
import { clearBrand } from '../brand.js';
import { useSession } from '../auth/session.js';
import { setSoundPrefs, useSoundPrefs, type SoundVolume } from '../alive/sound-prefs.js';
import { playTone } from '../alive/tones.js';
import '../i18n/alive.js';
import { useT } from '../i18n/locale.js';
import { useProfile } from './profile.js';

/**
 * The account menu (D-449): who you are, in which roles, My account (M40), this person's sounds
 * (M44a, D-766: on or off, and how loud, kept in this browser) and Sign out.
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
  const sound = useSoundPrefs();

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
        <MenuLabel>{t('alive.sound.title')}</MenuLabel>
        <MenuCheckboxItem
          checked={!sound.muted}
          // Keep the menu open: the person may change the volume next.
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(on) => {
            setSoundPrefs({ muted: !on });
            if (on) playTone('message', { preview: true });
          }}
        >
          {sound.muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
          {t('alive.sound.play')}
        </MenuCheckboxItem>
        <MenuRadioGroup
          aria-label={t('alive.sound.volume')}
          value={sound.volume}
          onValueChange={(value) => {
            setSoundPrefs({ volume: value as SoundVolume });
            playTone('message', { preview: true });
          }}
        >
          {(['low', 'medium', 'high'] as const).map((volume) => (
            <MenuRadioItem
              key={volume}
              value={volume}
              disabled={sound.muted}
              onSelect={(event) => event.preventDefault()}
              className="pl-9"
            >
              {t(`alive.sound.${volume}`)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
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
