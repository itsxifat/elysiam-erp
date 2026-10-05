import { Button, cn, Monogram } from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  BarChart3,
  Building2,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Store,
  Sun,
  Trophy,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { useMe } from '../session.js';
import { isDark, setTheme } from '../theme.js';

/**
 * The owner console's frame: the figures first, then each brand's page, then the settings
 * (brands, people) and the activity log. Neutral chrome, one accent (§24).
 */

interface Item {
  readonly to: string;
  readonly label: MessageKey;
  readonly icon: LucideIcon;
}

const MAIN: readonly Item[] = [
  { to: '/', label: 'nav.overview', icon: LayoutDashboard },
  { to: '/leaderboard', label: 'nav.leaderboard', icon: Trophy },
  { to: '/accounts', label: 'nav.accounts', icon: Landmark },
];

const SETTINGS: readonly Item[] = [
  { to: '/settings/brands', label: 'nav.brands', icon: Building2 },
  { to: '/settings/people', label: 'nav.people', icon: Users },
  { to: '/activity', label: 'nav.activity', icon: Activity },
];

export function brandsQueryKey() {
  return ['brands'] as const;
}

function active(to: string, pathname: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}

const LINK = cn(
  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground',
  'hover:bg-accent hover:text-foreground',
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
);
const LINK_ACTIVE = 'bg-selected font-medium text-selected-foreground';

function Navigation({ onNavigate }: { readonly onNavigate?: () => void }) {
  const { t } = useLocale();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const brands = useQuery({ queryKey: brandsQueryKey(), queryFn: endpoints.brands });

  const item = ({ to, label, icon: Icon }: Item) => {
    const here = active(to, pathname);
    return (
      <li key={to}>
        <Link
          to={to}
          className={cn(LINK, here && LINK_ACTIVE)}
          aria-current={here ? 'page' : undefined}
          onClick={onNavigate}
        >
          <Icon aria-hidden="true" className={cn('size-4', here && 'text-primary')} />
          {t(label)}
        </Link>
      </li>
    );
  };

  const pages = (brands.data?.brands ?? []).filter((brand) => brand.isActive);
  return (
    <nav
      aria-label={t('nav.main')}
      className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4"
    >
      <ul className="space-y-0.5">{MAIN.map(item)}</ul>
      {pages.length === 0 ? null : (
        <div>
          <p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
            {t('nav.brandPages')}
          </p>
          <ul className="space-y-0.5">
            {pages.map((brand) => {
              const to = `/brands/${brand.id}`;
              const here = active(to, pathname);
              return (
                <li key={brand.id}>
                  <Link
                    to="/brands/$brandId"
                    params={{ brandId: brand.id }}
                    className={cn(LINK, here && LINK_ACTIVE)}
                    aria-current={here ? 'page' : undefined}
                    onClick={onNavigate}
                  >
                    <Store aria-hidden="true" className={cn('size-4', here && 'text-primary')} />
                    <span className="truncate">{brand.displayName}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="mt-auto">
        <p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
          {t('nav.settings')}
        </p>
        <ul className="space-y-0.5">{SETTINGS.map(item)}</ul>
      </div>
    </nav>
  );
}

export function Shell() {
  const { t, locale, setLocale } = useLocale();
  const me = useMe();
  const queryClient = useQueryClient();
  const [dark, setDark] = useState(isDark);
  const [menuOpen, setMenuOpen] = useState(false);

  async function signOut() {
    try {
      await endpoints.signOut();
    } finally {
      queryClient.clear();
      window.location.assign('/');
    }
  }

  return (
    <div className="min-h-dvh bg-canvas text-foreground">
      <a
        href="#owner-main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        {t('shell.skip')}
      </a>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-sidebar shrink-0 flex-col md:flex">
          <div className="flex h-topbar items-center gap-2 px-5">
            <BarChart3 aria-hidden="true" className="size-4 text-primary" />
            <span className="text-sm font-semibold tracking-tight">{t('app.name')}</span>
          </div>
          <Navigation />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
          <div className="flex min-h-dvh flex-1 flex-col bg-background md:min-h-[calc(100dvh-1rem)] md:rounded-xl md:border md:border-border">
            <header className="sticky top-0 z-30 flex h-topbar shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:rounded-t-xl md:px-5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label={t('shell.menu')}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Menu aria-hidden="true" />
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocale(locale === 'en' ? 'bn' : 'en')}
              >
                {locale === 'en' ? t('shell.toBangla') : t('shell.toEnglish')}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={dark ? t('shell.toLight') : t('shell.toDark')}
                onClick={() => {
                  setTheme(!dark);
                  setDark(!dark);
                }}
              >
                {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
              </Button>
              <div className="ml-1 flex items-center gap-2" title={me.email}>
                <Monogram name={me.name} size="sm" />
                <span className="sr-only">
                  {t('shell.signedInAs')} {me.name}
                </span>
                <span className="hidden text-sm text-muted-foreground lg:inline">{me.name}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                <LogOut aria-hidden="true" />
                <span className="hidden sm:inline">{t('auth.signOut')}</span>
              </Button>
            </header>
            {menuOpen ? (
              <div className="border-b border-border md:hidden">
                <Navigation onNavigate={() => setMenuOpen(false)} />
              </div>
            ) : null}
            <main
              id="owner-main"
              className="mx-auto w-full max-w-page min-w-0 flex-1 px-4 pt-6 pb-12 md:px-8 md:pt-8"
            >
              <Outlet />
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}
