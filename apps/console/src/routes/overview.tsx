import { StatusBadge } from '@elysium/ui';

import { useSession } from '../auth/session.js';
import { useT } from '../i18n/locale.js';

/**
 * The landing screen.
 *
 * Deliberately thin: M05 is the frame, and every metric worth putting here is
 * owned by a module that does not exist yet. What it does do is show the three
 * facts that make the frame's behaviour legible — the active brand, the roles the
 * navigation was computed from, and the branch scope — so that when a later
 * milestone's screen shows fewer rows than expected, the first place to look
 * answers why.
 */
export function OverviewPage() {
  const session = useSession();
  const t = useT();
  const context = session.context;

  const org = session.orgs.find((candidate) => candidate.orgId === context?.orgId) ?? null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{t('overview.title')}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{t('overview.subtitle')}</p>
      </header>

      <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        <Tile label={t('overview.activeOrg')}>{org?.displayName ?? t('org.none')}</Tile>
        <Tile label={t('overview.yourRoles')}>
          <span className="flex flex-wrap gap-1">
            {session.roles.length === 0 ? (
              <span className="text-muted-foreground">{t('common.none')}</span>
            ) : (
              session.roles.map((role) => (
                <StatusBadge key={role} tone="neutral">
                  {role}
                </StatusBadge>
              ))
            )}
          </span>
        </Tile>
        <Tile label={t('overview.branchScope')}>
          {context === null || context.branchIds.length === 0
            ? t('workspace.wholeOrg')
            : String(context.branchIds.length)}
        </Tile>
      </dl>

      <p className="max-w-2xl text-sm text-muted-foreground">{t('overview.shellNote')}</p>
    </div>
  );
}

function Tile({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}
