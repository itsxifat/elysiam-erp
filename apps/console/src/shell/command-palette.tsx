import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { Languages, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useAbility } from '../auth/session.js';
import { useLocale, useT } from '../i18n/locale.js';
import { navigableItems } from './navigation.js';
import { applyTheme, isDark } from '../theme.js';

/**
 * The command palette (M05 checks 7 and 10).
 *
 * `cmdk`, on the same Radix dialog as everything else, so the focus trap and
 * restore are the ones already proven rather than a second implementation. The
 * palette is the fastest path through a dense application for anybody who uses it
 * daily, and §24 makes the order desk and POS keyboard-first — this is the part
 * of that which every screen inherits for free.
 *
 * **Its entries come from the same CASL-filtered navigation as the sidebar.** That
 * is not a convenience: a palette with its own list would offer a sales agent a
 * jump to Accounts, and a keyboard shortcut to a 403 is worse than a link to one
 * because it is faster and the user cannot see where it went wrong.
 *
 * The shortcut is Ctrl/Cmd+K and it is captured at the document, so it works
 * wherever focus happens to be. `preventDefault` matters: Cmd+K is the browser's
 * own search-bar focus on some platforms, and without it the palette opens behind
 * a focused address bar.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ability = useAbility();
  const { locale, setLocale } = useLocale();
  const t = useT();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setOpen((value) => !value);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const items = navigableItems(ability);

  function run(action: () => void) {
    // Closed before the action, so a navigation does not leave the overlay
    // painted over the screen it just went to — which reads as a frozen app.
    setOpen(false);
    action();
  }

  return (
    /*
     * cmdk's own Radix dialog wrapper, rather than composing Radix here.
     *
     * It is the same `@radix-ui/react-dialog` underneath — so the focus trap and
     * restore are the proven ones — and it wires the listbox semantics between the
     * dialog and the command list for us. Composing it by hand means either
     * importing Radix into the console as a second dependency on the same package
     * version, or getting the `aria-activedescendant` relationship subtly wrong,
     * which is the kind of error an axe scan does not catch and a screen-reader
     * user hits immediately.
     */
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t('palette.title')}
      overlayClassName="fixed inset-0 z-50 bg-foreground/40"
      contentClassName="fixed top-24 left-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-dialog"
    >
      <Command.Input
        placeholder={t('palette.placeholder')}
        className="h-control-lg w-full border-b border-border bg-transparent px-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-1">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
          {t('palette.empty')}
        </Command.Empty>

        <Command.Group
          heading={t('palette.groupNavigate')}
          className="px-1 py-1 text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
        >
          {items.map((item) => (
            <Command.Item
              key={item.to}
              value={`${t(item.labelKey)} ${item.to}`}
              onSelect={() => run(() => void navigate({ to: item.to }))}
              className="flex h-control cursor-pointer items-center gap-2.5 rounded-sm px-2 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
            >
              <item.icon aria-hidden="true" className="size-4 text-muted-foreground" />
              {t(item.labelKey)}
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group
          heading={t('palette.groupCommands')}
          className="px-1 py-1 text-xs text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
        >
          <Command.Item
            value={`${t('theme.toDark')} ${t('theme.toLight')}`}
            onSelect={() => run(() => applyTheme(isDark() ? 'light' : 'dark'))}
            className="flex h-control cursor-pointer items-center gap-2.5 rounded-sm px-2 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
          >
            {isDark() ? (
              <Sun aria-hidden="true" className="size-4 text-muted-foreground" />
            ) : (
              <Moon aria-hidden="true" className="size-4 text-muted-foreground" />
            )}
            {isDark() ? t('theme.toLight') : t('theme.toDark')}
          </Command.Item>

          <Command.Item
            value={t(locale === 'bn' ? 'shell.localeToEnglish' : 'shell.localeToBangla')}
            onSelect={() => run(() => setLocale(locale === 'bn' ? 'en' : 'bn'))}
            className="flex h-control cursor-pointer items-center gap-2.5 rounded-sm px-2 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
          >
            <Languages aria-hidden="true" className="size-4 text-muted-foreground" />
            {t(locale === 'bn' ? 'shell.localeToEnglish' : 'shell.localeToBangla')}
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
