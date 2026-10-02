import type { MessageKey } from '@elysium/i18n';

import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';

/**
 * The keys the performance screens render (M20): the agent's dashboard, targets, bonus
 * rules, the productivity report and the payroll run's target bonuses.
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, like every other section's.
 * Keys ending in an enum value (`perf.metric.delivered_revenue`,
 * `perf.version.pending_approval`) are built from the server's own vocabulary at the call
 * site, the way `hr.run.*` is.
 */
const PERF_KEYS = [
  'perf.title',
  'perf.myTitle',
  'perf.myHint',
  'perf.targets',
  'perf.targetsHint',
  'perf.bonusRules',
  'perf.bonusRulesHint',
  'perf.productivity',
  'perf.productivityHint',
  'perf.month',
  'perf.metric',
  'perf.metric.confirmed_orders',
  'perf.metric.delivered_orders',
  'perf.metric.delivered_revenue',
  'perf.target',
  'perf.achieved',
  'perf.progress',
  'perf.week',
  'perf.planned',
  'perf.workingDays',
  'perf.employee',
  'perf.newTarget',
  'perf.cancelTarget',
  'perf.refresh',
  'perf.status.active',
  'perf.status.cancelled',
  'perf.noEmployee',
  'perf.emptyTargets',
  'perf.pickups',
  'perf.medianPickup',
  'perf.p90Pickup',
  'perf.handled',
  'perf.activeHours',
  'perf.perHour',
  'perf.from',
  'perf.to',
  'perf.show',
  'perf.ruleName',
  'perf.definition',
  'perf.definitionHint',
  'perf.newRule',
  'perf.newVersion',
  'perf.version',
  'perf.preview',
  'perf.submit',
  'perf.version.draft',
  'perf.version.pending_approval',
  'perf.version.approved',
  'perf.version.rejected',
  'perf.version.superseded',
  'perf.total',
  'perf.capped',
  'perf.invalidJson',
  'perf.emptyRules',
  'perf.emptyProductivity',
  'perf.runBonuses',
  'perf.runBonusesHint',
  'perf.applyBonuses',
  'perf.emptyAwards',
  'perf.rule',
  'perf.deniedTitle',
  'perf.deniedDetail',
  'hr.errorTitle',
  'hr.errorDetail',
  'hr.retry',
  'hr.saveFailed',
  'hr.emptyTitle',
] as const satisfies readonly MessageKey[];

export type PerfMessageKey = (typeof PERF_KEYS)[number];

export const perfMessages = sectionCatalogue(PERF_KEYS);

/** The performance screens' lookup; throws on a missing value, like `useHrT`. */
export function usePerfT(): (key: PerfMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = perfMessages[locale][key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}
