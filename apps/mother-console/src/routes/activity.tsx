import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  Skeleton,
} from '@elysium/ui';
import type { ActivityWire } from '@elysium/mother-shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';

import { endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';

/**
 * What was done here (D-487): every sign-in, owner link, brand change and people action,
 * newest first. The log is append-only; this screen only reads it.
 */

const ACTIONS: Readonly<Record<string, MessageKey>> = {
  'auth.sign_in.succeeded': 'action.auth.sign_in.succeeded',
  'auth.sign_in.failed': 'action.auth.sign_in.failed',
  'auth.sign_in.password_accepted': 'action.auth.sign_in.password_accepted',
  'auth.two_factor.failed': 'action.auth.two_factor.failed',
  'auth.two_factor.enrolment_started': 'action.auth.two_factor.enrolment_started',
  'auth.two_factor.disabled': 'action.auth.two_factor.disabled',
  'auth.password_set': 'action.auth.password_set',
  'auth.password_set.failed': 'action.auth.password_set.failed',
  'auth.signed_out': 'action.auth.signed_out',
  'brand.added': 'action.brand.added',
  'brand.changed': 'action.brand.changed',
  'brand.connection_changed': 'action.brand.connection_changed',
  'brand.connection_tested': 'action.brand.connection_tested',
  'brand.owner_link_key.created': 'action.brand.owner_link_key.created',
  'brand.owner_link_key.rotated': 'action.brand.owner_link_key.rotated',
  'brand.owner_link.issued': 'action.brand.owner_link.issued',
  'brand.pull_requested': 'action.brand.pull_requested',
  'person.bootstrapped': 'action.person.bootstrapped',
  'person.invited': 'action.person.invited',
  'person.invite_reissued': 'action.person.invite_reissued',
  'person.removed': 'action.person.removed',
  'person.two_factor_reset.requested': 'action.person.two_factor_reset.requested',
  'person.two_factor_reset.approved': 'action.person.two_factor_reset.approved',
  'person.two_factor_reset.rejected': 'action.person.two_factor_reset.rejected',
  'person.two_factor_reset.break_glass': 'action.person.two_factor_reset.break_glass',
  'account.name_changed': 'action.account.name_changed',
  'account.password_changed': 'action.account.password_changed',
  'account.check_failed': 'action.account.check_failed',
  'account.two_factor.new_app_started': 'action.account.two_factor.new_app_started',
  'account.two_factor.new_app_confirmed': 'action.account.two_factor.new_app_confirmed',
  'account.backup_codes.renewed': 'action.account.backup_codes.renewed',
  'account.session.signed_out': 'action.account.session.signed_out',
  'account.sessions.signed_out_others': 'action.account.sessions.signed_out_others',
};

/** The few detail fields worth a glance; the rest stays in the log. */
function summary(detail: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const key of [
    'slug',
    'email',
    'name',
    'jti',
    'result',
    'reason',
    'method',
    'full',
    'step',
    'browser',
    'os',
    'count',
  ]) {
    const value = detail[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join(' · ');
}

export function ActivityPage() {
  const { t } = useLocale();
  const log = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => endpoints.activity(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last: ActivityWire) => last.next ?? undefined,
  });
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title={t('activity.title')} description={t('activity.description')} />
      {log.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : log.isError ? (
        <ErrorState title={t('common.error')} detail={t('common.errorDetail')} />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title={t('activity.empty')} />
      ) : (
        <Section title={t('activity.title')} bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <caption className="sr-only">{t('activity.title')}</caption>
              <thead>
                <tr className="border-y border-border text-xs text-muted-foreground">
                  <th scope="col" className="px-5 py-2 text-left font-medium">
                    {t('activity.when')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t('activity.who')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    {t('activity.what')}
                  </th>
                  <th scope="col" className="px-5 py-2 text-left font-medium">
                    {t('activity.detail')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2 whitespace-nowrap text-muted-foreground">
                      <DateTime value={item.occurredAt} compact />
                    </td>
                    <td className="px-3 py-2">{item.actor?.name ?? t('activity.system')}</td>
                    <td className="px-3 py-2">
                      {ACTIONS[item.action] === undefined
                        ? item.action
                        : t(ACTIONS[item.action] ?? 'activity.system')}
                    </td>
                    <td className="max-w-md truncate px-5 py-2 font-mono text-xs text-muted-foreground">
                      {summary(item.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {log.hasNextPage ? (
            <div className="border-t border-border px-5 py-3">
              <Button
                variant="outline"
                size="sm"
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                {t('activity.more')}
              </Button>
            </div>
          ) : null}
        </Section>
      )}
    </div>
  );
}
