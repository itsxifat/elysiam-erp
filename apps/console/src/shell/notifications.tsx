import type { MessageKey } from '@elysium/i18n';
import { Button, DateTime, Popover, PopoverContent, PopoverTrigger } from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { Bell, CalendarClock, CheckCheck, PackageX, ShieldCheck, ShieldX } from 'lucide-react';
import { useReducer, useState } from 'react';

import { useT } from '../i18n/locale.js';
import { approvalTypeLabel } from '../routes/approvals-status.js';
import { DEFAULT_PAGE_SIZE } from '../lib/table-search.js';
import { useRealtime } from '../realtime/use-realtime.js';
import { EMPTY_INBOX, inboxReducer, itemFromEvent, unreadCount, type InboxItem } from './inbox.js';

/**
 * The notifications inbox in the header (M05; §10 Notifications, §19 events).
 *
 * A bell with an unread count, and a panel listing what arrived this session:
 * approvals waiting on this person, and decisions on the ones they raised. M16's
 * in-app channel feeds the same list through `notification.created` when it lands
 * (§19's row for that event targets `user:{id}`, as these do).
 *
 * The count is in the button's accessible name, not only in the badge, because a
 * badge is a coloured shape and a screen reader user is owed the number too.
 */

const INBOX_EVENTS = [
  'approval.requested',
  'approval.decided',
  'loan.instalment_due',
  // D-903: a parcel the courier has not received, to the supervisors.
  'parcel.not_received',
] as const;

/** Every entry is about an approval, so each opens the approvals list at its start. */
const APPROVALS_FIRST_PAGE = { page: 1, pageSize: DEFAULT_PAGE_SIZE } as const;

const DECISION_LABELS: Record<
  Extract<InboxItem, { kind: 'approval_decided' }>['decision'],
  MessageKey
> = {
  approved: 'shell.notifyApproved',
  auto_approved: 'shell.notifyAutoApproved',
  rejected: 'shell.notifyRejected',
};

const ITEM_CLASS =
  'flex gap-3 px-4 py-3 text-sm hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset';

function Unread({ read, label }: { readonly read: boolean; readonly label: string }) {
  if (read) return null;
  return (
    <>
      <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
      <span className="sr-only">{label}</span>
    </>
  );
}

export function NotificationInbox() {
  const t = useT();
  const [inbox, dispatch] = useReducer(inboxReducer, EMPTY_INBOX);
  const [open, setOpen] = useState(false);

  const status = useRealtime({
    events: INBOX_EVENTS,
    onEvent: (name, payload) => {
      const item = itemFromEvent(name, payload, Date.now());
      if (item !== null) dispatch({ type: 'received', item });
    },
  });

  const unread = unreadCount(inbox);
  const name =
    unread === 0
      ? t('shell.notifications')
      : `${t('shell.notifications')}, ${String(unread)} ${t('shell.unread')}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={name} className="relative">
          <Bell aria-hidden="true" />
          {unread === 0 ? null : (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs leading-none font-medium text-primary-foreground tabular-nums"
            >
              {unread > 9 ? '9+' : String(unread)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('shell.notifications')}
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t('shell.notifications')}</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={unread === 0}
            onClick={() => dispatch({ type: 'markAllRead' })}
          >
            <CheckCheck aria-hidden="true" />
            {t('shell.markAllRead')}
          </Button>
        </div>

        {status === 'disconnected' ? (
          <p
            role="status"
            className="border-b border-border px-4 py-2 text-xs text-muted-foreground"
          >
            {t('shell.notificationsPaused')}
          </p>
        ) : null}

        {inbox.items.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-medium">{t('shell.notificationsEmpty')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('shell.notificationsEmptyDetail')}
            </p>
          </div>
        ) : (
          <ul className="max-h-96 divide-y divide-border overflow-y-auto">
            {inbox.items.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                {item.kind === 'parcel_not_received' ? (
                  <Link to="/courier/stuck" onClick={() => setOpen(false)} className={ITEM_CLASS}>
                    <span aria-hidden="true" className="mt-0.5 text-destructive-text">
                      <PackageX className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={item.read ? 'block' : 'block font-medium'}>
                        {t('shell.notifyParcelNotReceived')}
                      </span>
                      <DateTime
                        value={new Date(item.at)}
                        className="block text-xs text-muted-foreground"
                      />
                    </span>
                    <Unread read={item.read} label={t('shell.unread')} />
                  </Link>
                ) : item.kind === 'loan_due' ? (
                  <Link
                    to="/loans/$loanId"
                    params={{ loanId: item.loanId }}
                    onClick={() => setOpen(false)}
                    className={ITEM_CLASS}
                  >
                    <span aria-hidden="true" className="mt-0.5 text-muted-foreground">
                      <CalendarClock className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={item.read ? 'block' : 'block font-medium'}>
                        {t('shell.notifyLoanDue')}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {item.dueOn}
                      </span>
                      <DateTime
                        value={new Date(item.at)}
                        className="block text-xs text-muted-foreground"
                      />
                    </span>
                    <Unread read={item.read} label={t('shell.unread')} />
                  </Link>
                ) : (
                  <Link
                    to="/approvals"
                    search={APPROVALS_FIRST_PAGE}
                    onClick={() => setOpen(false)}
                    className={ITEM_CLASS}
                  >
                    <span aria-hidden="true" className="mt-0.5 text-muted-foreground">
                      {item.kind === 'approval_decided' && item.decision === 'rejected' ? (
                        <ShieldX className="size-4" />
                      ) : (
                        <ShieldCheck className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={item.read ? 'block' : 'block font-medium'}>
                        {item.kind === 'approval_requested'
                          ? t('shell.notifyApprovalRequested')
                          : t(DECISION_LABELS[item.decision])}
                      </span>
                      {item.kind === 'approval_requested' ? (
                        <span className="block text-xs text-muted-foreground">
                          {approvalTypeLabel(item.type, t)}
                        </span>
                      ) : null}
                      <DateTime
                        value={new Date(item.at)}
                        className="block text-xs text-muted-foreground"
                      />
                    </span>
                    <Unread read={item.read} label={t('shell.unread')} />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-border px-4 py-2 text-right">
          <Link
            to="/approvals"
            search={APPROVALS_FIRST_PAGE}
            onClick={() => setOpen(false)}
            className="rounded-sm text-xs font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t('shell.openApprovals')}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
