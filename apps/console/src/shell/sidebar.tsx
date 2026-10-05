import { cn, readStored, STORAGE_KEYS, writeStored } from '@elysium/ui';
import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { OrgSwitcher } from '../auth/org-switcher.js';
import { useSession } from '../auth/session.js';
import { useT } from '../i18n/locale.js';
import { visibleNavigation, type NavItem, type NavSection } from './navigation.js';

/**
 * The sidebar (D-449): the brand at the top, the work in quiet groups, Settings at the
 * foot.
 *
 * Three shapes, one component:
 *
 * - **full** (a wide screen): labels, group headings that fold away, remembered;
 * - **rail** (a laptop under 1280px, or whenever the person folds it): icons only, the
 *   label as a tooltip and still the link's accessible name;
 * - **drawer** (a phone): the full shape inside a sheet, opened from the topbar.
 *
 * The active entry is a filled pill in the neutral `selected` step with its icon in the
 * accent, plus `aria-current="page"`, so "where am I" is never carried by colour alone.
 */

function readFolded(): ReadonlySet<string> {
  try {
    const raw = readStored(STORAGE_KEYS.navGroups);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeFolded(folded: ReadonlySet<string>): void {
  // Storage denied: the fold holds for this visit only.
  writeStored(STORAGE_KEYS.navGroups, JSON.stringify([...folded]));
}

export function isActive(item: NavItem, pathname: string): boolean {
  // Exact match for the root, prefix match for everything else, so `/orders/42`
  // still highlights Orders while `/` does not highlight on every screen.
  return item.to === '/'
    ? pathname === '/'
    : pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export interface SidebarContentProps {
  /** `rail` folds to icons whatever the screen; `auto` is full on a wide screen, rail below. */
  readonly mode: 'auto' | 'rail' | 'drawer';
  readonly onNavigate?: () => void;
  readonly onToggleRail?: () => void;
}

export function SidebarContent({ mode, onNavigate, onToggleRail }: SidebarContentProps) {
  const session = useSession();
  const t = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const sections = visibleNavigation(session.ability);
  const [folded, setFolded] = useState(readFolded);

  // In `auto`, the labels show from xl up; in `rail` never; in the drawer always.
  const label = mode === 'drawer' ? '' : mode === 'rail' ? 'sr-only' : 'sr-only xl:not-sr-only';
  const showOnlyFull = mode === 'drawer' ? '' : mode === 'rail' ? 'hidden' : 'hidden xl:flex';

  function toggle(key: string) {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFolded(next);
    writeFolded(next);
  }

  const footerItems = sections.flatMap((section) => section.items.filter((item) => item.footer));

  // Whether the list runs on past its lower edge, for the fade that says so.
  const list = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const element = list.current;
    if (element === null) return;
    const measure = () => {
      setClipped(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('px-3 pt-3 pb-2', mode === 'rail' && 'px-2')}>
        <OrgSwitcher
          orgs={session.orgs}
          activeOrgId={session.context?.orgId ?? null}
          onSwitched={() => session.refresh()}
          compact={mode === 'rail' ? 'always' : mode === 'auto' ? 'below-xl' : 'never'}
        />
      </div>

      {/*
       * The list scrolls; the footer (Settings, and folding the sidebar) stays put on a
       * solid ground under a hairline, so the last entry is never half under it. When
       * there is more below, the list's lower edge fades to say so.
       */}
      <nav aria-label={t('nav.primary')} className="flex min-h-0 flex-1 flex-col">
        <div
          ref={list}
          data-clipped={clipped ? 'end' : undefined}
          className={cn(
            'min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pt-2 pb-4 data-[clipped=end]:fade-y-end',
            mode === 'rail' && 'px-2',
          )}
        >
          {sections.map((section) => (
            <Group
              key={section.titleKey}
              section={section}
              items={section.items.filter((item) => item.footer !== true)}
              pathname={pathname}
              folded={folded.has(section.titleKey)}
              onToggle={() => toggle(section.titleKey)}
              mode={mode}
              labelClass={label}
              headingClass={showOnlyFull}
              {...(onNavigate === undefined ? {} : { onNavigate })}
            />
          ))}
        </div>

        {footerItems.length === 0 && onToggleRail === undefined ? null : (
          <div
            className={cn(
              'flex shrink-0 gap-1 border-t border-border bg-canvas px-3 py-2',
              mode === 'rail' ? 'flex-col px-2' : 'items-center',
              mode === 'auto' && 'flex-col xl:flex-row',
            )}
          >
            {footerItems.length === 0 ? null : (
              <ul className="min-w-0 flex-1 space-y-0.5">
                {footerItems.map((item) => (
                  <Entry
                    key={item.to}
                    item={item}
                    active={isActive(item, pathname)}
                    labelClass={label}
                    mode={mode}
                    {...(onNavigate === undefined ? {} : { onNavigate })}
                  />
                ))}
              </ul>
            )}
            {onToggleRail === undefined ? null : (
              <button
                type="button"
                onClick={onToggleRail}
                aria-label={mode === 'rail' ? t('nav.expand') : t('nav.collapse')}
                title={mode === 'rail' ? t('nav.expand') : t('nav.collapse')}
                className={cn(
                  'hidden size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground xl:flex',
                  'motion-safe:duration-fast hover:bg-selected/70 hover:text-foreground motion-safe:transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  footerItems.length === 0 && mode !== 'rail' && 'ml-auto',
                  mode === 'rail' && 'self-center',
                )}
              >
                {mode === 'rail' ? (
                  <PanelLeftOpen aria-hidden="true" className="size-4" />
                ) : (
                  <PanelLeftClose aria-hidden="true" className="size-4" />
                )}
              </button>
            )}
          </div>
        )}
      </nav>
    </div>
  );
}

function Group({
  section,
  items,
  pathname,
  folded,
  onToggle,
  mode,
  labelClass,
  headingClass,
  onNavigate,
}: {
  readonly section: NavSection;
  readonly items: readonly NavItem[];
  readonly pathname: string;
  readonly folded: boolean;
  readonly onToggle: () => void;
  readonly mode: SidebarContentProps['mode'];
  readonly labelClass: string;
  readonly headingClass: string;
  readonly onNavigate?: () => void;
}) {
  const t = useT();
  if (items.length === 0) return null;

  // A folded group still shows the entry you are on: folding must never hide where you are.
  const holdsActive = items.some((item) => isActive(item, pathname));
  const shown = folded && !holdsActive ? [] : items;
  const listId = `nav-group-${section.titleKey.replace(/\W/g, '-')}`;

  return (
    <div>
      {section.untitled === true ? null : (
        <>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!folded || holdsActive}
            aria-controls={listId}
            className={cn(
              'group/heading mb-1 h-7 w-full items-center justify-between rounded-md px-2 text-xs font-medium text-muted-foreground',
              'motion-safe:duration-fast hover:text-foreground motion-safe:transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              headingClass === '' ? 'flex' : headingClass,
            )}
          >
            {t(section.titleKey)}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-3.5 opacity-0 group-hover/heading:opacity-100 group-focus-visible/heading:opacity-100 motion-safe:transition-transform',
                folded && !holdsActive && '-rotate-90 opacity-100',
              )}
            />
          </button>
          {/* In the rail the heading folds away; a hairline keeps the groups apart. */}
          {mode === 'drawer' ? null : (
            <div
              aria-hidden="true"
              className={cn(
                'mx-2 mb-2 h-px bg-border',
                mode === 'rail' ? 'block' : 'block xl:hidden',
              )}
            />
          )}
        </>
      )}
      <ul
        id={listId}
        className={cn(
          'space-y-0.5',
          // In the rail every entry shows: folding is a full-sidebar affordance.
          mode !== 'drawer' && shown.length === 0 && 'xl:hidden',
        )}
      >
        {(mode === 'drawer' ? shown : items).map((item) => (
          <Entry
            key={item.to}
            item={item}
            active={isActive(item, pathname)}
            labelClass={labelClass}
            mode={mode}
            hiddenWhenFull={mode === 'auto' && !shown.includes(item)}
            {...(onNavigate === undefined ? {} : { onNavigate })}
          />
        ))}
      </ul>
    </div>
  );
}

function Entry({
  item,
  active,
  labelClass,
  mode,
  hiddenWhenFull = false,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly labelClass: string;
  readonly mode: SidebarContentProps['mode'];
  readonly hiddenWhenFull?: boolean;
  readonly onNavigate?: () => void;
}) {
  const t = useT();
  const label = t(item.labelKey);
  return (
    <li className={cn('group/entry relative', hiddenWhenFull && 'xl:hidden')}>
      <Link
        to={item.to}
        {...(active ? { 'aria-current': 'page' as const } : {})}
        {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
        className={cn(
          'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm',
          'motion-safe:duration-fast motion-safe:transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          mode === 'rail' && 'justify-center px-0',
          mode === 'auto' && 'justify-center px-0 xl:justify-start xl:px-2',
          active
            ? 'bg-selected font-medium text-selected-foreground'
            : 'text-muted-foreground hover:bg-selected/60 hover:text-foreground',
        )}
      >
        <item.icon
          aria-hidden="true"
          className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-current')}
        />
        <span className={cn('truncate', labelClass)}>{label}</span>
      </Link>
      {/* The rail's tooltip: the label, beside the icon. It repeats the link's name, so
          it is hidden from assistive technology, and drawn from an attribute rather than a
          text node, so the label exists once in the page's text. */}
      {mode === 'drawer' ? null : (
        <span
          aria-hidden="true"
          data-tip={label}
          className={cn(
            'pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-xs font-medium whitespace-nowrap text-background opacity-0 shadow-popover',
            'after:content-[attr(data-tip)]',
            'motion-safe:duration-fast motion-safe:transition-opacity',
            'group-has-[:focus-visible]/entry:opacity-100 [@media(hover:hover)]:group-hover/entry:opacity-100',
            mode === 'auto' && 'xl:hidden',
          )}
        />
      )}
    </li>
  );
}
