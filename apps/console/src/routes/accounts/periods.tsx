import { Button, Dialog, Input, Label, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { AccountsHeader, Block, Empty, LoadFailed, LoadingRows } from './accounts-parts.js';
import { closePeriod, dhakaToday, listPeriods, requestReopen, type Period } from './api.js';
import { useAccountsT, type AccountsMessageKey } from './messages.js';
import { isMonth, monthOf, previousMonth } from './report-dates.js';
import { MonthPicker } from '../../ui/date-picker.js';

/**
 * Accounting periods (M03, §7): close a month, and ask for a closed one to reopen.
 *
 * Closing locks every date in the month and before it (D-093), so it is offered
 * for a month that has ended and not for the current one. Reopening is
 * maker-checker (D-094): this screen raises the request with a reason and a second
 * person decides it in Approvals, which is why the button says "request" and the
 * result says who decides.
 *
 * The server's refusals each get their own sentence, because each tells the person
 * what to do next: wait for the month to end, close the earlier month first, or
 * wait for the pending request.
 */

const REFUSALS: Readonly<Record<string, AccountsMessageKey>> = {
  PERIOD_NOT_ENDED: 'accounts.periods.notEnded',
  PERIOD_ALREADY_CLOSED: 'accounts.periods.alreadyClosed',
  PERIOD_NOT_CLOSED: 'accounts.periods.notClosed',
  PERIOD_REOPEN_PENDING: 'accounts.periods.reopenPending',
  PERIOD_LATER_CLOSED: 'accounts.periods.laterClosed',
  PERIOD_REOPEN_UNAUTHORISED: 'accounts.periods.reopenUnauthorised',
};

function refusal(error: unknown): AccountsMessageKey {
  if (error instanceof ApiError && error.code !== null) {
    return REFUSALS[error.code] ?? 'accounts.periods.failed';
  }
  return 'accounts.periods.failed';
}

export function PeriodsPage() {
  const a = useAccountsT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const formId = useId();

  const mayRead = ability.can('read', 'LedgerPeriod');
  const mayClose = ability.can('update', 'LedgerPeriod');
  const periods = useQuery({
    queryKey: ['ledger', 'periods'],
    queryFn: listPeriods,
    enabled: mayRead,
  });

  const lastMonth = previousMonth(monthOf(dhakaToday()));
  const [month, setMonth] = useState(lastMonth);
  const [notice, setNotice] = useState<{ key: AccountsMessageKey; tone: 'ok' | 'bad' } | null>(
    null,
  );
  const [reopening, setReopening] = useState<Period | null>(null);
  const [reason, setReason] = useState('');

  const close = useMutation({
    mutationFn: closePeriod,
    onSuccess: async () => {
      setNotice({ key: 'accounts.periods.closed', tone: 'ok' });
      await queryClient.invalidateQueries({ queryKey: ['ledger'] });
    },
    onError: (error: unknown) => setNotice({ key: refusal(error), tone: 'bad' }),
  });

  const reopen = useMutation({
    mutationFn: requestReopen,
    onSuccess: async () => {
      setReopening(null);
      setReason('');
      setNotice({ key: 'accounts.periods.reopenRequested', tone: 'ok' });
      await queryClient.invalidateQueries({ queryKey: ['ledger', 'periods'] });
    },
    onError: (error: unknown) => {
      setReopening(null);
      setNotice({ key: refusal(error), tone: 'bad' });
    },
  });

  return (
    <div className="space-y-6">
      <AccountsHeader
        title={a('accounts.periods.title')}
        subtitle={a('accounts.periods.subtitle')}
      />
      <PermissionGate
        allowed={mayRead}
        explain={{
          title: a('accounts.reports.deniedTitle'),
          detail: a('accounts.reports.deniedDetail'),
        }}
      >
        {notice === null ? null : (
          <p
            role={notice.tone === 'bad' ? 'alert' : 'status'}
            className={`rounded-md border border-border px-3 py-2 text-sm ${notice.tone === 'bad' ? 'text-destructive' : 'text-foreground'}`}
          >
            {a(notice.key)}
          </p>
        )}

        {mayClose ? (
          <Block
            title={a('accounts.periods.closeHeading')}
            caption={a('accounts.periods.closeCaption')}
          >
            <form
              className="flex flex-wrap items-end gap-3 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (isMonth(month)) close.mutate(month);
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor={`${formId}-month`}>{a('accounts.periods.month')}</Label>
                <MonthPicker
                  id={`${formId}-month`}
                  value={month}
                  max={lastMonth}
                  className="w-44"
                  onValueChange={setMonth}
                />
              </div>
              <Button type="submit" disabled={close.isPending || !isMonth(month)}>
                {a('accounts.periods.close')}
              </Button>
            </form>
          </Block>
        ) : null}

        <Block title={a('accounts.periods.listHeading')}>
          {periods.isPending ? (
            <LoadingRows />
          ) : periods.isError ? (
            <LoadFailed onRetry={() => void periods.refetch()} />
          ) : periods.data.items.length === 0 ? (
            <Empty label="accounts.periods.empty" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="h-row px-4 text-left font-medium">
                    {a('accounts.periods.month')}
                  </th>
                  <th scope="col" className="h-row px-4 text-left font-medium">
                    {a('accounts.colStatus')}
                  </th>
                  <th scope="col" className="h-row px-4 text-left font-medium">
                    {a('accounts.periods.closedAt')}
                  </th>
                  {mayClose ? <th scope="col" className="h-row px-4" /> : null}
                </tr>
              </thead>
              <tbody>
                {periods.data.items.map((period) => (
                  <tr key={period.id} className="border-b border-border last:border-0">
                    <td className="h-row px-4 tabular-nums">{period.month}</td>
                    <td className="h-row px-4">
                      <StatusBadge tone={period.status === 'closed' ? 'neutral' : 'info'}>
                        {a(
                          period.status === 'closed'
                            ? 'accounts.periods.statusClosed'
                            : 'accounts.periods.statusOpen',
                        )}
                      </StatusBadge>
                    </td>
                    <td className="h-row px-4 text-muted-foreground tabular-nums">
                      {period.closedAt?.slice(0, 10) ?? '—'}
                    </td>
                    {mayClose ? (
                      <td className="h-row px-4 text-right">
                        {period.status === 'closed' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`${a('accounts.periods.requestReopen')}: ${period.month}`}
                            onClick={() => {
                              setNotice(null);
                              setReopening(period);
                            }}
                          >
                            {a('accounts.periods.requestReopen')}
                          </Button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Block>

        {reopening === null ? null : (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setReopening(null);
            }}
            title={`${a('accounts.periods.requestReopen')} · ${reopening.month}`}
            description={a('accounts.periods.reopenDetail')}
            closeLabel={a('accounts.periods.cancel')}
            footer={
              <>
                <Button variant="outline" onClick={() => setReopening(null)}>
                  {a('accounts.periods.cancel')}
                </Button>
                <Button
                  disabled={reason.trim() === '' || reopen.isPending}
                  onClick={() => reopen.mutate({ month: reopening.month, reason: reason.trim() })}
                >
                  {a('accounts.periods.requestReopen')}
                </Button>
              </>
            }
          >
            <div className="space-y-1.5">
              <Label htmlFor={`${formId}-reason`} required>
                {a('accounts.periods.reason')}
              </Label>
              <Input
                id={`${formId}-reason`}
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </Dialog>
        )}
      </PermissionGate>
    </div>
  );
}
