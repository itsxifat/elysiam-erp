import { Button } from '@elysium/ui';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { Command as CommandIcon, Languages, LogOut, Moon, Sun } from 'lucide-react';
import { useState } from 'react';

import { endpoints } from '../api.js';
import { clearBrand } from '../brand.js';
import { OrgSwitcher } from '../auth/org-switcher.js';
import { useSession } from '../auth/session.js';
import { useLocale, useT } from '../i18n/locale.js';
import { CommandPalette } from './command-palette.js';
import { visibleNavigation } from './navigation.js';
import { applyTheme, isDark } from '../theme.js';

/**
 * The console frame: sidebar, topbar, and the outlet every module fills (§24).
 *
 * Restrained on purpose. The chrome is neutral, the only colour is the accent on
 * the active navigation item, and separation is a 1px hairline — because the
 * screens inside it are the product and a decorated frame competes with them for
 * eight hours a day.
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

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#console-main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t('shell.skipToContent')}
      </a>

      <CommandPalette />

      <div className="flex min-h-dvh">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main id="console-main" className="min-w-0 flex-1 px-6 py-6">
            {session.context === null ? null : <Outlet />}
          </main>
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  const ability = useSession().ability;
  const t = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const sections = visibleNavigation(ability);

  return (
    <nav
      aria-label={t('nav.primary')}
      className="hidden w-60 shrink-0 border-r border-border bg-card md:block"
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold tracking-tight">{t('workspace.title')}</span>
      </div>

      <div className="space-y-5 px-2 py-4">
        {sections.map((section) => (
          <div key={section.titleKey}>
            <p className="px-2 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground">
              {t(section.titleKey)}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                // Exact match for the root, prefix match for everything else, so
                // `/orders/42` still highlights Orders while `/` does not
                // highlight on every screen.
                const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      {...(active ? { 'aria-current': 'page' as const } : {})}
                      className={
                        active
                          ? 'flex h-control items-center gap-2.5 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground'
                          : 'motion-safe:duration-fast flex h-control items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground motion-safe:transition-colors'
                      }
                    >
                      <item.icon aria-hidden="true" className="size-4 shrink-0" />
                      {t(item.labelKey)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function Topbar() {
  const session = useSession();
  const { locale, setLocale } = useLocale();
  const t = useT();
  const [dark, setDark] = useState(isDark);

  function toggleTheme() {
    const next = !dark;
    applyTheme(next ? 'dark' : 'light');
    setDark(next);
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
      <OrgSwitcher
        orgs={session.orgs}
        activeOrgId={session.context?.orgId ?? null}
        onSwitched={() => session.refresh()}
      />

      <div className="flex items-center gap-1.5">
        {/*
         * A visible, mouse-reachable way into the palette, with its shortcut
         * shown beside it. A keyboard-only entry point is a feature most users
         * never learn exists; printing `Ctrl K` on the button is how the shortcut
         * teaches itself.
         */}
        <Button
          variant="outline"
          size="sm"
          aria-keyshortcuts="Control+K Meta+K"
          onClick={() => {
            // Dispatched rather than lifted into state, so the palette owns its
            // own open/close in one place — including the shortcut — and this
            // button is just another way to press the shortcut.
            document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
            );
          }}
        >
          <CommandIcon aria-hidden="true" />
          {t('shell.openPalette')}
          <kbd className="ml-1 rounded-sm border border-border px-1 text-xs text-muted-foreground">
            {t('shell.paletteHint')}
          </kbd>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label={t(locale === 'bn' ? 'shell.localeToEnglish' : 'shell.localeToBangla')}
          onClick={() => setLocale(locale === 'bn' ? 'en' : 'bn')}
        >
          <Languages aria-hidden="true" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label={dark ? t('theme.toLight') : t('theme.toDark')}
          onClick={toggleTheme}
        >
          {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label={t('auth.signOut')}
          onClick={() => {
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
        </Button>
      </div>
    </header>
  );
}
