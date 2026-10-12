import {
  Button,
  EmptyState,
  ErrorState,
  Kbd,
  PermissionGate,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  cn,
} from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { BellRing, Keyboard, MessagesSquare } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import '../../alive/alive.css';
import { useArrivals, useFlip, useNow } from '../../alive/motion.js';
import { askForAlerts, rememberAsked, shouldOfferAlerts } from '../../alive/notify.js';
import { playTone } from '../../alive/tones.js';
import { ApiError } from '../../api.js';
import { useAbility, useSession } from '../../auth/session.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { myDesk } from '../orders/workflow-api.js';
import { INBOX_KEY, listConversations, type ConversationItem } from './api.js';
import { ContactAvatar } from './avatar.js';
import { useSingleKeys } from './inbox-keys.js';
import './inbox.css';
import {
  CHANNEL_KINDS,
  CONTACT_STAGES,
  inboxSearchSchema,
  stageTone,
  type InboxSearch,
} from './logic.js';
import { useInboxT } from './messages.js';
import { Conversation, type Pane } from './thread.js';
import { hasBangla, relativeTime, stepConversation } from './thread-logic.js';
import { timeText } from './time-text.js';

/**
 * The unified inbox (M42, D-730 to D-749; M44a, D-760 to D-767): every channel in one list on
 * the left, the thread in the middle, the customer panel on the right, filling the window under
 * the shell's header with each pane scrolling on its own.
 *
 * Live, the way the approvals inbox is: §19's events carry ids only, so an event invalidates the
 * queries it concerns and the server answers again through `serializeFor`; nothing from the
 * socket is shown as it arrived. A write on someone else's conversation asks first (D-737). The
 * sounds and desktop alerts for new messages are the shell's work dock's, heard on every screen.
 */

const INBOX_EVENTS = [
  'inbox.message_received',
  'inbox.message_status',
  'inbox.conversation_changed',
  'inbox.owner_overridden',
  'inbox.contact_updated',
] as const;

export function InboxPage() {
  const ability = useAbility();
  const t = useInboxT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Conversation')}
      explain={{ title: t('inbox.deniedTitle'), detail: t('inbox.deniedDetail') }}
    >
      <Inbox />
    </PermissionGate>
  );
}

function Inbox() {
  const t = useInboxT();
  // Parsed here rather than by the route (see `routes.tsx`); a hand-edited value falls back.
  const raw: unknown = useSearch({ strict: false });
  const search = inboxSearchSchema.parse(raw ?? {});
  const routerNavigate = useNavigate();
  const navigate = (next: (prev: InboxSearch) => InboxSearch) =>
    void routerNavigate({ to: '.', search: next(search) as never });
  const queryClient = useQueryClient();
  const session = useSession();
  const me = session.context?.userId ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('thread');
  const order = useRef<readonly string[]>([]);

  const status = useRealtime({
    events: INBOX_EVENTS,
    enabled: session.context !== null,
    onEvent: (name, payload) => {
      const body = (payload ?? {}) as {
        conversationId?: unknown;
        conversationIds?: unknown;
        status?: unknown;
        action?: unknown;
      };
      void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] });
      const ids = [
        ...(typeof body.conversationId === 'string' ? [body.conversationId] : []),
        ...(Array.isArray(body.conversationIds)
          ? body.conversationIds.filter((id): id is string => typeof id === 'string')
          : []),
      ];
      for (const id of ids) {
        void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'thread', id] });
        void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'panel', id] });
      }
      if (name === 'inbox.message_status' && body.status === 'failed') playTone('error');
      if (name === 'inbox.owner_overridden') {
        setNotice(
          t('inbox.owner.overridden', {
            name: t('inbox.someone'),
            action: typeof body.action === 'string' ? body.action.replace(/[._]/g, ' ') : '',
          }),
        );
      }
    },
  });

  const filters = {
    view: search.view,
    channel: search.channel,
    stage: search.stage,
    unread: search.unread,
    closed: search.closed,
    q: search.q,
  };

  const select = (id: string) => {
    setPane('thread');
    navigate((prev) => ({ ...prev, c: id }));
  };

  useSingleKeys({
    j: () => {
      const next = stepConversation(order.current, search.c ?? null, 1);
      if (next !== null && next !== search.c) select(next);
    },
    k: () => {
      const next = stepConversation(order.current, search.c ?? null, -1);
      if (next !== null && next !== search.c) select(next);
    },
    '/': () => {
      const box = document.querySelector<HTMLTextAreaElement>('[data-inbox-composer]');
      if (box !== null && !box.disabled) box.focus();
    },
  });

  const open = search.c !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
        <h1 className="text-base font-semibold">{t('inbox.title')}</h1>
        <StatusBadge
          tone={status === 'connected' ? 'success' : 'warning'}
          className={status === 'connected' ? 'alive-presence' : undefined}
        >
          {status === 'connected' ? t('inbox.live') : t('inbox.offline')}
        </StatusBadge>
        <MyStatus />
        <div className="ml-auto flex items-center gap-2">
          <AlertsOffer />
          <ShortcutsHelp />
        </div>
      </header>
      {notice === null ? null : (
        <p role="status" className="border-b border-border bg-muted px-4 py-2 text-sm">
          {notice}
        </p>
      )}
      <div className="inbox-grid" data-open={open ? pane : 'list'}>
        <ConversationList
          filters={filters}
          selected={search.c ?? null}
          me={me}
          onSelect={select}
          onOrder={(ids) => {
            order.current = ids;
          }}
          onFilters={(next) => navigate((prev) => ({ ...prev, ...next }))}
        />
        {search.c === undefined ? (
          <div className="inbox-thread flex items-center justify-center p-6">
            <EmptyState
              icon={MessagesSquare}
              title={t('inbox.thread.pick')}
              detail={t('inbox.thread.pickDetail')}
            />
          </div>
        ) : (
          <Conversation
            key={search.c}
            id={search.c}
            me={me}
            onBack={() => navigate((prev) => ({ ...prev, c: undefined }))}
            onPane={setPane}
          />
        )}
      </div>
      {open && pane === 'customer' ? (
        <div className="inbox-small-only border-t border-border p-2">
          <Button variant="outline" size="sm" className="w-full" onClick={() => setPane('thread')}>
            {t('inbox.thread.showMessages')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** "You · Active", breathing while active: the dock's own heartbeat, read from its cache. */
function MyStatus() {
  const t = useInboxT();
  const ability = useAbility();
  const desk = useQuery({
    queryKey: ['team', 'me'],
    queryFn: myDesk,
    enabled: ability.can('update', 'Presence'),
    staleTime: 30_000,
  });
  const presence = desk.data?.presence;
  if (presence === undefined) return null;
  const tone =
    presence.state === 'active' ? 'success' : presence.state === 'idle' ? 'warning' : 'neutral';
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
      <span className="sr-only">{t('inbox.you')}:</span>
      <span aria-hidden="true">{t('alive.presence.you')}</span>
      <StatusBadge
        tone={tone}
        className={presence.state === 'active' ? 'alive-presence' : undefined}
      >
        {t(`inbox.presence.${presence.state}`)}
      </StatusBadge>
    </span>
  );
}

/** "Turn on alerts", once: asked from a button, never on load (D-766). */
function AlertsOffer() {
  const t = useInboxT();
  const [offer, setOffer] = useState(shouldOfferAlerts);
  if (!offer) return null;
  return (
    <div className="alive-in flex items-center gap-2 rounded-md bg-info-subtle px-2.5 py-1 text-xs text-info-subtle-foreground">
      <BellRing aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="hidden max-w-80 md:block">{t('alive.notify.ask')}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setOffer(false);
          void askForAlerts();
        }}
      >
        {t('alive.notify.allow')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOffer(false);
          rememberAsked();
        }}
      >
        {t('alive.notify.later')}
      </Button>
    </div>
  );
}

function ShortcutsHelp() {
  const t = useInboxT();
  const rows = [
    ['J', t('inbox.shortcuts.next')],
    ['K', t('inbox.shortcuts.previous')],
    ['A', t('inbox.shortcuts.take')],
    ['E', t('inbox.shortcuts.close')],
    ['/', t('inbox.shortcuts.reply')],
  ] as const;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('inbox.shortcuts.title')}>
          <Keyboard aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="mb-2 text-sm font-medium">{t('inbox.shortcuts.title')}</p>
        <dl className="space-y-1.5 text-sm">
          {rows.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <Kbd>{key}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

// --- the list -----------------------------------------------------------------------------------

function ConversationList({
  filters,
  selected,
  me,
  onSelect,
  onOrder,
  onFilters,
}: {
  readonly filters: Omit<InboxSearch, 'c'>;
  readonly selected: string | null;
  readonly me: string | null;
  readonly onSelect: (id: string) => void;
  readonly onOrder: (ids: readonly string[]) => void;
  readonly onFilters: (next: Partial<InboxSearch>) => void;
}) {
  const t = useInboxT();
  const ids = useId();
  const [text, setText] = useState(filters.q ?? '');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((filters.q ?? '') !== text) onFilters({ q: text === '' ? undefined : text });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, filters.q, onFilters]);

  const list = useQuery({
    queryKey: [...INBOX_KEY, 'list', filters],
    queryFn: () => listConversations(filters),
    // A safety net while the socket reconnects; events invalidate it the rest of the time.
    refetchInterval: 60_000,
  });
  const items = list.data?.items;
  useEffect(() => {
    onOrder(items?.map((item) => item.id) ?? []);
  }, [items, onOrder]);

  const views = [
    ['all', t('inbox.view.all')],
    ['mine', t('inbox.view.mine')],
    ['unassigned', t('inbox.view.unassigned')],
  ] as const;

  return (
    <section aria-labelledby={`${ids}-title`} className="inbox-list flex min-h-0 flex-col">
      <h2 id={`${ids}-title`} className="sr-only">
        {t('inbox.list.label')}
      </h2>
      <div className="space-y-2 border-b border-border p-3">
        <div role="group" aria-label={t('inbox.view.label')} className="flex gap-1">
          {views.map(([view, label]) => (
            <Button
              key={view}
              size="sm"
              variant={filters.view === view ? 'secondary' : 'ghost'}
              aria-pressed={filters.view === view}
              onClick={() => onFilters({ view })}
            >
              {label}
            </Button>
          ))}
        </div>
        <SearchInput
          className="sm:w-full"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onClear={() => setText('')}
          clearLabel={t('inbox.cancel')}
          placeholder={t('inbox.filter.search')}
          aria-label={t('inbox.filter.search')}
        />
        <div className="grid grid-cols-2 gap-2">
          <Select
            size="sm"
            variant="filter"
            aria-label={t('inbox.filter.channel')}
            value={filters.channel ?? ''}
            onValueChange={(value) =>
              onFilters({ channel: value === '' ? undefined : (value as InboxSearch['channel']) })
            }
            options={[
              { value: '', label: t('inbox.filter.anyChannel') },
              ...CHANNEL_KINDS.map((kind) => ({ value: kind, label: t(`inbox.channel.${kind}`) })),
            ]}
          />
          <Select
            size="sm"
            variant="filter"
            aria-label={t('inbox.filter.stage')}
            value={filters.stage ?? ''}
            onValueChange={(value) =>
              onFilters({ stage: value === '' ? undefined : (value as InboxSearch['stage']) })
            }
            options={[
              { value: '', label: t('inbox.filter.anyStage') },
              ...CONTACT_STAGES.map((stage) => ({
                value: stage,
                label: t(`inbox.stage.${stage}`),
              })),
            ]}
          />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 rounded-sm accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              checked={filters.unread === true}
              onChange={(event) => onFilters({ unread: event.target.checked ? true : undefined })}
            />
            {t('inbox.filter.unread')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 rounded-sm accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              checked={filters.closed === true}
              onChange={(event) => onFilters({ closed: event.target.checked ? true : undefined })}
            />
            {t('inbox.filter.closed')}
          </label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <ul className="space-y-1 p-2" aria-busy="true" aria-label={t('inbox.loading')}>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <li key={n} className="flex items-center gap-3 px-2 py-2.5">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <span className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                </span>
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <ErrorState
            title={t('inbox.errorTitle')}
            detail={list.error instanceof ApiError ? list.error.message : t('inbox.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
                {t('inbox.retry')}
              </Button>
            }
          />
        ) : list.data.items.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title={t('inbox.list.empty')}
            detail={t('inbox.list.emptyDetail')}
          />
        ) : (
          <Rows items={list.data.items} selected={selected} me={me} onSelect={onSelect} />
        )}
      </div>
    </section>
  );
}

/** The rows, mounted once there are some: what was there first never animates. */
function Rows({
  items,
  selected,
  me,
  onSelect,
}: {
  readonly items: readonly ConversationItem[];
  readonly selected: string | null;
  readonly me: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const t = useInboxT();
  const listRef = useRef<HTMLUListElement>(null);
  const now = useNow();
  const arrivals = useArrivals(items.map((item) => item.id));
  const [counts] = useState(() => new Map(items.map((item) => [item.id, item.unreadCount])));
  useFlip(listRef, items.map((item) => item.id).join(','));
  return (
    <ul ref={listRef} aria-label={t('inbox.list.label')}>
      {items.map((item) => (
        <ConversationRow
          key={item.id}
          item={item}
          me={me}
          now={now}
          selected={item.id === selected}
          arrived={arrivals.has(item.id)}
          countChanged={counts.get(item.id) !== item.unreadCount}
          onSelect={() => onSelect(item.id)}
        />
      ))}
    </ul>
  );
}

function ConversationRow({
  item,
  me,
  now,
  selected,
  arrived,
  countChanged,
  onSelect,
}: {
  readonly item: ConversationItem;
  readonly me: string | null;
  readonly now: number;
  readonly selected: boolean;
  readonly arrived: boolean;
  readonly countChanged: boolean;
  readonly onSelect: () => void;
}) {
  const t = useInboxT();
  const name = item.contact.name ?? t('inbox.unknownPerson');
  const unread = item.unreadCount > 0;
  const owner =
    item.assignedTo === null
      ? t('inbox.list.nobody')
      : item.assignedTo.userId === me
        ? t('inbox.list.you')
        : (item.assignedTo.name ?? t('inbox.someone'));
  const preview = item.lastPreview ?? '';
  return (
    <li data-flip-key={item.id} className={cn('border-b border-border', arrived && 'alive-in')}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'alive-press flex w-full items-start gap-3 px-3 py-2.5 text-left',
          'motion-safe:duration-fast hover:bg-accent motion-safe:transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
          selected && 'bg-selected text-selected-foreground',
        )}
      >
        <ContactAvatar id={item.contact.id} name={item.contact.name} url={item.contact.avatarUrl} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span
              lang={hasBangla(name) ? 'bn' : undefined}
              className={cn('truncate text-sm', unread ? 'font-semibold' : 'font-medium')}
            >
              {name}
            </span>
            <time
              dateTime={item.lastMessageAt}
              className={cn(
                'ml-auto shrink-0 text-xs',
                unread ? 'font-medium text-primary' : 'text-muted-foreground',
              )}
            >
              {timeText(relativeTime(item.lastMessageAt, now), t)}
            </time>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span
              lang={hasBangla(preview) ? 'bn' : undefined}
              className={cn(
                'truncate text-sm',
                unread ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {item.lastDirection === 'outbound'
                ? t('inbox.list.youWrote', { text: preview })
                : preview}
            </span>
            {unread ? (
              <span
                key={item.unreadCount}
                className={cn(
                  'ml-auto shrink-0 rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums',
                  countChanged && 'alive-pop',
                )}
                aria-label={t('inbox.list.unread', { n: String(item.unreadCount) })}
              >
                {item.unreadCount}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <StatusBadge tone="neutral">{t(`inbox.channel.${item.channel}`)}</StatusBadge>
            {item.contact.stage === 'visitor' ? null : (
              <StatusBadge tone={stageTone(item.contact.stage)}>
                {t(`inbox.stage.${item.contact.stage}`)}
              </StatusBadge>
            )}
            <span className="truncate">{owner}</span>
          </span>
        </span>
      </button>
    </li>
  );
}
