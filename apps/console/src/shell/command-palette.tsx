import { Kbd, readStored, STORAGE_KEYS, writeStored } from '@elysium/ui';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { ArrowRight, CornerDownLeft, History, Languages, Moon, Search, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useAbility } from '../auth/session.js';
import { useLocale, useT } from '../i18n/locale.js';
import {
  navigableItems,
  visiblePaletteActions,
  visiblePalettePages,
  type NavItem,
} from './navigation.js';
import { applyTheme, isDark } from '../theme.js';

/**
 * The command palette (M05 checks 7 and 10; D-463).
 *
 * The fastest way through the console for anyone who knows what they want: type
 * "new order", "transfer", "stuck" or a screen's name and press Enter. It reaches
 * three kinds of thing:
 *
 * - **actions**, named as what people do ("Take a new order"), with the words they
 *   actually type matched as keywords;
 * - **every screen**, the sidebar's sections and the tabs inside them, each shown with
 *   the section it lives in;
 * - **preferences**, the theme and the language.
 *
 * With nothing typed it opens on the last few places it took you, so the second visit
 * to a screen is two keystrokes.
 *
 * **Its entries come from the same CASL-filtered lists as the sidebar.** That is not a
 * convenience: a palette with its own list would offer a sales agent a jump to
 * Accounts, and a keyboard shortcut to a 403 is worse than a link to one because it
 * is faster and the user cannot see where it went wrong.
 *
 * `cmdk`, on the same Radix dialog as everything else, so the focus trap and restore
 * are the proven ones and the listbox semantics between the input and the list are
 * wired for us. The palette is its own chunk; the shell owns the shortcut and the open
 * state, and loads this the moment the first screen has rendered.
 */

const RECENT_LIMIT = 4;

function readRecent(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(readStored(STORAGE_KEYS.paletteRecent) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function remember(to: string): void {
  // Storage denied: no recents this visit, nothing else lost.
  const next = [to, ...readRecent().filter((entry) => entry !== to)].slice(0, RECENT_LIMIT);
  writeStored(STORAGE_KEYS.paletteRecent, JSON.stringify(next));
}

interface Entry {
  readonly to: string;
  readonly label: string;
  readonly parent: string | null;
  readonly icon: NavItem['icon'];
}

const ITEM_CLASS =
  'group flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm text-foreground select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground';
const GROUP_CLASS =
  'px-2 pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

export function CommandPalette({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const ability = useAbility();
  const { locale, setLocale } = useLocale();
  const t = useT();
  const [query, setQuery] = useState('');

  const sections: Entry[] = navigableItems(ability).map((item) => ({
    to: item.to,
    label: t(item.labelKey),
    parent: null,
    icon: item.icon,
  }));
  const pages: Entry[] = visiblePalettePages(ability).map((page) => ({
    to: page.to,
    label: t(page.labelKey),
    parent: t(page.parentKey),
    icon: page.icon,
  }));
  const screens = [...sections, ...pages];
  const actions = visiblePaletteActions(ability);
  const recent =
    query === ''
      ? readRecent().flatMap((to) => {
          const found = screens.find((entry) => entry.to === to);
          return found === undefined ? [] : [found];
        })
      : [];

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) setQuery('');
  }

  function run(action: () => void) {
    // Closed before the action, so a navigation does not leave the overlay
    // painted over the screen it just went to — which reads as a frozen app.
    close(false);
    action();
  }

  function go(to: string) {
    run(() => {
      remember(to);
      void navigate({ to });
    });
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={close}
      label={t('palette.title')}
      loop
      overlayClassName="fixed inset-0 z-50 bg-overlay motion-safe:animate-fade"
      contentClassName="fixed top-[12vh] left-1/2 z-50 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-dialog motion-safe:animate-in"
    >
      <div className="flex items-center gap-3 border-b border-border px-4">
        <Search aria-hidden="true" className="size-4.5 shrink-0 text-muted-foreground" />
        {/* Uncontrolled: cmdk filters and re-selects in the same pass as the keystroke, so an
            Enter right after typing opens the best match rather than the previous one. */}
        <Command.Input
          onValueChange={setQuery}
          placeholder={t('palette.placeholder')}
          className="h-13 w-full bg-transparent text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>

      <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto pb-2">
        <Command.Empty className="px-4 py-10 text-center text-sm text-muted-foreground">
          {t('palette.empty')}
        </Command.Empty>

        {recent.length === 0 ? null : (
          <Command.Group heading={t('palette.groupRecent')} className={GROUP_CLASS}>
            {recent.map((entry) => (
              <Item
                key={`recent-${entry.to}`}
                value={`recent ${entry.label} ${entry.parent ?? ''} ${entry.to}`}
                onSelect={() => go(entry.to)}
                icon={<History aria-hidden="true" className="size-4 text-muted-foreground" />}
                label={entry.label}
                trail={entry.parent}
              />
            ))}
          </Command.Group>
        )}

        <Command.Group heading={t('palette.groupNavigate')} className={GROUP_CLASS}>
          {screens.map((entry) => (
            <Item
              key={entry.to}
              value={`${entry.label} ${entry.parent ?? ''} ${entry.to}`}
              onSelect={() => go(entry.to)}
              icon={<entry.icon aria-hidden="true" className="size-4 text-muted-foreground" />}
              label={entry.label}
              trail={entry.parent}
            />
          ))}
        </Command.Group>

        {actions.length === 0 ? null : (
          <Command.Group heading={t('palette.groupActions')} className={GROUP_CLASS}>
            {actions.map((action) => (
              <Item
                key={action.id}
                value={`${t(action.labelKey)} ${action.id}`}
                keywords={[...action.keywords]}
                onSelect={() => go(action.to)}
                icon={<action.icon aria-hidden="true" className="size-4 text-primary" />}
                label={t(action.labelKey)}
                trail={null}
              />
            ))}
          </Command.Group>
        )}

        <Command.Group heading={t('palette.groupPreferences')} className={GROUP_CLASS}>
          <Item
            value={`${t('theme.toDark')} ${t('theme.toLight')} theme dark light`}
            onSelect={() => run(() => applyTheme(isDark() ? 'light' : 'dark'))}
            icon={
              isDark() ? (
                <Sun aria-hidden="true" className="size-4 text-muted-foreground" />
              ) : (
                <Moon aria-hidden="true" className="size-4 text-muted-foreground" />
              )
            }
            label={isDark() ? t('theme.toLight') : t('theme.toDark')}
            trail={null}
          />
          <Item
            value={`${t(locale === 'bn' ? 'shell.localeToEnglish' : 'shell.localeToBangla')} language bangla english`}
            onSelect={() => run(() => setLocale(locale === 'bn' ? 'en' : 'bn'))}
            icon={<Languages aria-hidden="true" className="size-4 text-muted-foreground" />}
            label={t(locale === 'bn' ? 'shell.localeToEnglish' : 'shell.localeToBangla')}
            trail={null}
          />
        </Command.Group>
      </Command.List>

      <div className="flex items-center gap-4 border-t border-border bg-canvas px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          {t('palette.footerMove')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft aria-hidden="true" className="size-3" />
          </Kbd>
          {t('palette.footerOpen')}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          {t('palette.footerClose')}
        </span>
      </div>
    </Command.Dialog>
  );
}

function Item({
  value,
  keywords,
  onSelect,
  icon,
  label,
  trail,
}: {
  readonly value: string;
  readonly keywords?: string[];
  readonly onSelect: () => void;
  readonly icon: ReactNode;
  readonly label: string;
  readonly trail: string | null;
}) {
  return (
    <Command.Item
      value={value}
      {...(keywords === undefined ? {} : { keywords })}
      onSelect={onSelect}
      className={ITEM_CLASS}
    >
      <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trail === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">{trail}</span>
      )}
      <ArrowRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-data-[selected=true]:opacity-100"
      />
    </Command.Item>
  );
}
