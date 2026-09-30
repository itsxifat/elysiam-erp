import { Building2, Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/locale.js';
import { endpoints, type AvailableOrg } from '../api.js';

/**
 * The org switcher (M02a, D-035).
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
 */

export interface OrgSwitcherProps {
  readonly orgs: readonly AvailableOrg[];
  readonly activeOrgId: string | null;
  readonly onSwitched: (orgId: string) => void | Promise<void>;
}

export function OrgSwitcher({ orgs, activeOrgId, onSwitched }: OrgSwitcherProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = orgs.find((org) => org.orgId === activeOrgId) ?? null;

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
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">{active?.displayName ?? t('org.none')}</span>
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
        className="inline-flex h-(--control-height-sm) items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
      >
        <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
        {busy ? t('org.switching') : (active?.displayName ?? t('org.chooseOne'))}
        <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
      </button>

      {open ? (
        <ul
          role="listbox"
          aria-label={t('org.switch')}
          className="absolute right-0 z-10 mt-1 min-w-56 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-popover"
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
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-popover-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span>
                    <span className="block font-medium">{org.displayName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {org.roles.join(', ')}
                    </span>
                  </span>
                  {current ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
