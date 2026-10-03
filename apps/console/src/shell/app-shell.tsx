import { Button, cn, Hint, Kbd, Monogram } from '@elysium/ui';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { Bell, ChevronRight, Menu as MenuIcon, Moon, Search, Sun } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { useSession } from '../auth/session.js';
import { useLocale, useT } from '../i18n/locale.js';
import { locate } from './navigation.js';
import { SidebarContent } from './sidebar.js';
import { applyTheme, isDark } from '../theme.js';

/*
 * The inbox is its own chunk, loaded as soon as the shell has rendered. It brings
 * the realtime socket client and the popover's positioning, about 29 KB gzipped
 * that the first page otherwise carried. Until it arrives the header shows the same
 * bell, inert, so nothing moves when it does.
 *
 * The palette, the account menu and the phone's drawer follow the same rule (D-451):
 * each is a chunk the first screen does not wait for. The palette and the menu are
 * fetched as soon as the shell has painted, so the shortcut is live a moment later;
 * the drawer only when a phone opens it.
 */
const NotificationInbox = lazy(() =>
  import('./notifications.js').then((module) => ({ default: module.NotificationInbox })),
);
const loadPalette = () =>
  import('./command-palette.js').then((module) => ({ default: module.CommandPalette }));
const CommandPalette = lazy(loadPalette);
const AccountMenu = lazy(() =>
  import('./account-menu.js').then((module) => ({ default: module.AccountMenu })),
);
const MobileNav = lazy(() =>
  import('./mobile-nav.js').then((module) => ({ default: module.MobileNav })),
);

const RAIL_KEY = 'elysium-sidebar';

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === 'rail';
  } catch {
    return false;
  }
}

/**
 * The console frame: sidebar, topbar, and the outlet every module fills (§24, D-449).
 *
 * Restrained on purpose. The chrome sits on the warm `canvas`; the page is a sheet
 * one step lighter, inset by a hairline, which is what separates "the tool" from
 * "the work" without a single heavy border. The only colour is the accent on the
 * active entry's icon and on the primary action of the page.
 *
 * Two accessibility details that are easy to leave out and expensive to add back:
 *
 * - **A skip link.** Without it a keyboard user tabs through every navigation
 *   entry before reaching the table they came for, on every page load. It is the
 *   single highest-value element in a shell with a sidebar.
 * - **`aria-current="page"`** on the active link, so the active state is not
 *   carried by colour alone. §24's floor requires a label beside every status
 *   colour, and "where am I" is a status.
 */
export function AppShell() {
  const session = useSession();
  const t = useT();
  const [rail, setRail] = useState(readRail);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteWanted, setPaletteWanted] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerWanted, setDrawerWanted] = useState(false);

  /*
   * Ctrl/Cmd+K, captured at the document so it works wherever focus is. The shell
   * owns it rather than the palette, because the palette is a lazy chunk and the
   * shortcut must work from the first keystroke. `preventDefault` matters: Cmd+K is
   * the browser's own search-bar focus on some platforms, and without it the palette
   * opens behind a focused address bar.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'k') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setPaletteWanted(true);
      setPaletteOpen((value) => !value);
    }
    document.addEventListener('keydown', onKeyDown);
    // Fetch the palette's chunk once the first screen is up, so the first Ctrl K
    // opens it without a pause.
    const idle = window.setTimeout(() => {
      void loadPalette();
    }, 600);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(idle);
    };
  }, []);

  function toggleRail() {
    const next = !rail;
    setRail(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? 'rail' : 'full');
    } catch {
      // Storage denied: the choice holds for this visit.
    }
  }

  return (
    <div className="min-h-dvh bg-canvas text-foreground">
      <a
        href="#console-main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t('shell.skipToContent')}
      </a>

      {paletteWanted ? (
        <Suspense fallback={null}>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        </Suspense>
      ) : null}

      {drawerWanted ? (
        <Suspense fallback={null}>
          <MobileNav open={drawerOpen} onOpenChange={setDrawerOpen} />
        </Suspense>
      ) : null}

      <div className="flex min-h-dvh">
        <aside
          aria-label={t('nav.sidebar')}
          className={cn(
            'sticky top-0 hidden h-dvh shrink-0 md:block',
            'motion-safe:duration-base motion-safe:transition-[width] motion-safe:ease-out',
            rail ? 'w-sidebar-collapsed' : 'w-sidebar-collapsed xl:w-sidebar',
          )}
        >
          <SidebarContent mode={rail ? 'rail' : 'auto'} onToggleRail={toggleRail} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
          <div className="flex min-h-dvh flex-1 flex-col bg-background md:min-h-[calc(100dvh-1rem)] md:rounded-xl md:border md:border-border">
            <Topbar
              onOpenPalette={() => {
                setPaletteWanted(true);
                setPaletteOpen(true);
              }}
              onOpenMenu={() => {
                setDrawerWanted(true);
                setDrawerOpen(true);
              }}
            />
            <main
              id="console-main"
              className="mx-auto w-full max-w-page min-w-0 flex-1 px-4 pt-6 pb-12 md:px-8 md:pt-8"
            >
              {session.context === null ? null : <Outlet />}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

function Topbar({
  onOpenPalette,
  onOpenMenu,
}: {
  readonly onOpenPalette: () => void;
  readonly onOpenMenu: () => void;
}) {
  const { locale, setLocale } = useLocale();
  const t = useT();
  const [dark, setDark] = useState(isDark);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const here = locate(pathname);

  function toggleTheme() {
    const next = !dark;
    applyTheme(next ? 'dark' : 'light');
    setDark(next);
  }

  return (
    <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-3 border-b border-border bg-background px-3 md:rounded-t-xl md:px-5">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        aria-label={t('shell.openMenu')}
        onClick={onOpenMenu}
      >
        <MenuIcon aria-hidden="true" />
      </Button>

      {/* Where you are: the section, then the screen. The sidebar says it too, but a
          person reading the page should not have to look left to know. */}
      <nav aria-label={t('shell.breadcrumb')} className="min-w-0 flex-1">
        {here === null ? null : (
          <ol className="flex min-w-0 items-center gap-1.5 text-sm">
            {here.section.untitled === true ? null : (
              <li className="hidden items-center gap-1.5 text-muted-foreground sm:flex">
                {t(here.section.titleKey)}
                <ChevronRight aria-hidden="true" className="size-3.5 opacity-60" />
              </li>
            )}
            <li className="truncate font-medium text-foreground">{t(here.item.labelKey)}</li>
          </ol>
        )}
      </nav>

      {/* The palette, as a search field: the visible way in, with its shortcut printed
          so it teaches itself. */}
      <button
        type="button"
        onClick={onOpenPalette}
        aria-keyshortcuts="Control+K Meta+K"
        className={cn(
          'flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm text-muted-foreground',
          'motion-safe:duration-fast hover:border-ring/50 hover:text-foreground motion-safe:transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
          'w-8 justify-center px-0 sm:w-56 sm:justify-start sm:px-2.5 lg:w-72',
        )}
      >
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only sm:not-sr-only sm:flex-1 sm:truncate sm:text-left">
          {t('shell.search')}
        </span>
        <span className="hidden items-center gap-0.5 sm:flex" aria-hidden="true">
          <Kbd>{t('shell.paletteHint')}</Kbd>
        </span>
      </button>

      <div className="flex items-center gap-0.5">
        <Suspense
          fallback={
            <Button variant="ghost" size="icon-sm" aria-label={t('shell.notifications')} disabled>
              <Bell aria-hidden="true" />
            </Button>
          }
        >
          <NotificationInbox />
        </Suspense>

        <Hint label={dark ? t('theme.toLight') : t('theme.toDark')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={dark ? t('theme.toLight') : t('theme.toDark')}
            onClick={toggleTheme}
          >
            {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </Button>
        </Hint>

        <Button
          variant="ghost"
          size="sm"
          className="px-2 text-muted-foreground hover:text-foreground"
          aria-label={t(locale === 'bn' ? 'shell.localeToEnglish' : 'shell.localeToBangla')}
          onClick={() => setLocale(locale === 'bn' ? 'en' : 'bn')}
        >
          <span
            lang={locale === 'bn' ? 'en' : 'bn'}
            className={locale === 'bn' ? '' : 'font-bangla'}
          >
            {locale === 'bn' ? t('shell.languageEnglish') : t('shell.languageBangla')}
          </span>
        </Button>
      </div>

      <Suspense
        fallback={
          <span className="flex size-8 items-center justify-center">
            <Monogram name="" size="md" className="rounded-full" />
          </span>
        }
      >
        <AccountMenu />
      </Suspense>
    </header>
  );
}
