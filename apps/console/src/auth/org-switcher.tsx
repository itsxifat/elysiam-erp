import { cn, Monogram } from '@elysium/ui';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/locale.js';
import { endpoints, type AvailableOrg } from '../api.js';

/**
 * The org switcher (M02a, D-035), at the head of the sidebar (D-449).
 *
 * "A user with one membership never sees a switcher" is a requirement, not a
 * nicety: four of the five brands are staffed by people who will only ever work
 * in one of them, and a control that only ever has one option is a control that
 * teaches people to click past it.
 *
 * Switching is a server round-trip, never a client-side filter. The active org
 * lives on the session row precisely so the database decides which rows exist,
 * and a switcher that changed local state would be showing the previous org's
 * data with the next org's name on it.
 *
 * The brand is shown as a monogram in the accent and its name, so whoever works in
 * two brands can tell at a glance which one the screen belongs to.
 */

export interface OrgSwitcherProps {
  readonly orgs: readonly AvailableOrg[];
  readonly activeOrgId: string | null;
  readonly onSwitched: (orgId: string) => void | Promise<void>;
  /** Icon-only in the sidebar's rail: always, under the xl breakpoint, or never. */
  readonly compact?: 'always' | 'below-xl' | 'never';
}

export function OrgSwitcher({
  orgs,
  activeOrgId,
  onSwitched,
  compact = 'never',
}: OrgSwitcherProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = orgs.find((org) => org.orgId === activeOrgId) ?? null;
  // A super admin starts in no brand: the switcher itself says to choose one.
  const name = active?.displayName ?? (orgs.length > 1 ? t('org.chooseOne') : t('org.none'));
  const text =
    compact === 'always' ? 'sr-only' : compact === 'below-xl' ? 'sr-only xl:not-sr-only' : '';

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // One membership is not a choice. Show where you are, without a control.
  if (orgs.length <= 1) {
    return (
      <div
        className={cn(
          'flex h-11 items-center gap-2.5 rounded-lg px-1.5',
          compact === 'always' && 'justify-center px-0',
          compact === 'below-xl' && 'justify-center px-0 xl:justify-start xl:px-1.5',
        )}
      >
        <Monogram name={name} tone="brand" />
        <span className={cn('min-w-0', text)}>
          <span className="block truncate text-sm font-semibold tracking-tight text-foreground">
            {name}
          </span>
        </span>
      </div>
    );
  }

  async function switchTo(orgId: string) {
    setBusy(true);
    try {
      await endpoints.setActiveOrg(orgId);
      await onSwitched(orgId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('org.switch')}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-11 w-full items-center gap-2.5 rounded-lg px-1.5 text-left',
          'motion-safe:duration-fast hover:bg-selected/60 motion-safe:transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60',
          open && 'bg-selected/60',
          compact === 'always' && 'justify-center px-0',
          compact === 'below-xl' && 'justify-center px-0 xl:justify-start xl:px-1.5',
        )}
      >
        <Monogram name={active?.displayName ?? ''} tone="brand" />
        <span className={cn('min-w-0 flex-1', text)}>
          <span className="block truncate text-sm font-semibold tracking-tight text-foreground">
            {busy ? t('org.switching') : name}
          </span>
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-muted-foreground',
            compact === 'always' && 'hidden',
            compact === 'below-xl' && 'hidden xl:block',
          )}
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label={t('org.switch')}
          className="absolute top-full left-0 z-50 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-popover motion-safe:animate-in"
        >
          {orgs.map((org) => {
            const current = org.orgId === activeOrgId;
            return (
              <li key={org.orgId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={current}
                  onClick={() => void switchTo(org.orgId)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                >
                  <Monogram name={org.displayName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{org.displayName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {org.roles.join(', ')}
                    </span>
                  </span>
                  {current ? (
                    <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
