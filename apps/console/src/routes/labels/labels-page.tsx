import type { MessageKey } from '@elysium/i18n';
import {
  PageHeader,
  PermissionGate,
  TabList,
  cn,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { z } from 'zod';

import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { useSchemaSearch } from '../orders/paths.js';
import { ThisComputer, useLabelEvents } from './parts.js';
import { PrintStation } from './print-station.js';
import { PrintersPanel } from './printers-panel.js';
import { LogPanel, QueuePanel, ReadyPanel } from './queue-panels.js';
import { TerminalsPanel } from './terminals-panel.js';

/**
 * Labels (M46, D-800): the label desks' own area. Ready for label (orders with a consignment and
 * a lot not yet labelled), the queue, the print log, the printers and the automatic printing
 * rule, the label terminals, and the browser print station. Keyboard- and scanner-first; a
 * printed or a failed job is heard (M44a's tones).
 */

const TABS = ['ready', 'queue', 'log', 'printers', 'terminals', 'station'] as const;
type Tab = (typeof TABS)[number];

const searchSchema = z.object({ tab: z.enum(TABS).catch('ready') });

export function LabelsPage() {
  const ability = useAbility();
  const t = useT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'PackingTerminal')}
      explain={{ title: t('lb.labels.title'), detail: t('lb.labels.denied') }}
    >
      <Labels />
    </PermissionGate>
  );
}

function Labels() {
  const t = useT();
  const [search, setSearch] = useSchemaSearch(searchSchema);
  useLabelEvents({ sounds: search.tab !== 'station' });
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('lb.labels.title')}
        description={t('lb.labels.subtitle')}
        actions={<ThisComputer />}
      />
      <TabList label={t('lb.labels.title')}>
        {TABS.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={search.tab === value ? 'page' : undefined}
            data-testid={`labels-tab-${value}`}
            className={cn(tabClassName, search.tab === value ? tabActiveClassName : null)}
            onClick={() => setSearch({ tab: value })}
          >
            {t(`lb.tab.${value}` as MessageKey)}
          </button>
        ))}
      </TabList>
      <Body tab={search.tab} />
    </div>
  );
}

function Body({ tab }: { readonly tab: Tab }) {
  switch (tab) {
    case 'ready':
      return <ReadyPanel />;
    case 'queue':
      return <QueuePanel />;
    case 'log':
      return <LogPanel />;
    case 'printers':
      return <PrintersPanel />;
    case 'terminals':
      return <TerminalsPanel kind="label" />;
    case 'station':
      return <PrintStation />;
  }
}
