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
import { BellRing, Check, Keyboard, MessagesSquare, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

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
  'inbox.media_ready',
  'inbox.call_changed',
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
      // A reply that did not go, in the chat on screen: a colleague's elsewhere is theirs to hear.
      if (
        name === 'inbox.message_status' &&
        body.status === 'failed' &&
        body.conversationId === search.c
      ) {
        playTone('error');
      }
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
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      {notice === null ? null : (
        <p
          role="status"
          className="mx-2 mt-2 flex items-center gap-2 rounded-lg border border-border bg-info-subtle px-3 py-2 text-sm text-info-subtle-foreground"
        >
          <BellRing aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <Button
            size="icon-sm"
            variant="ghost"
            className="rounded-full"
            aria-label={t('inbox.cancel')}
            onClick={() => setNotice(null)}
          >
            <X aria-hidden="true" />
          </Button>
        </p>
      )}
      <div className="inbox-grid" data-open={open ? pane : 'list'}>
        <ConversationList
          filters={filters}
          selected={search.c ?? null}
          me={me}
          live={status === 'connected'}
          onSelect={select}
          onOrder={(ids) => {
            order.current = ids;
          }}
          onFilters={(next) => navigate((prev) => ({ ...prev, ...next }))}
        />
        {search.c === undefined ? (
          <div className="inbox-thread inbox-chat flex items-center justify-center p-6">
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
        <div className="inbox-small-only border-t border-border bg-background p-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full rounded-full"
            onClick={() => setPane('thread')}
          >
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
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="sr-only">{t('inbox.you')}:</span>
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
    <div className="alive-in flex flex-wrap items-center gap-2 rounded-xl bg-info-subtle px-3 py-2 text-xs text-info-subtle-foreground">
      <BellRing aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{t('alive.notify.ask')}</span>
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label={t('inbox.shortcuts.title')}
        >
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
  live,
  onSelect,
  onOrder,
  onFilters,
}: {
  readonly filters: Omit<InboxSearch, 'c'>;
  readonly selected: string | null;
  readonly me: string | null;
  /** The realtime socket is up: the dot beside the title breathes. */
  readonly live: boolean;
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
      <div className="space-y-2.5 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">{t('inbox.title')}</h1>
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            title={live ? t('inbox.live') : t('inbox.offline')}
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-2 rounded-full',
                live ? 'alive-presence bg-success' : 'bg-destructive',
              )}
            />
            <span className="sr-only">{live ? t('inbox.live') : t('inbox.offline')}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <MyStatus />
            <ShortcutsHelp />
          </div>
        </div>
        <AlertsOffer />
        <div
          role="group"
          aria-label={t('inbox.view.label')}
          className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5"
        >
          {views.map(([view, label]) => (
            <button
              key={view}
              type="button"
              aria-pressed={filters.view === view}
              onClick={() => onFilters({ view })}
              className={cn(
                'motion-safe:duration-fast h-7 rounded-md text-sm motion-safe:transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                filters.view === view
                  ? 'border-border bg-background font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <SearchInput
          className="inbox-search sm:w-full"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onClear={() => setText('')}
          clearLabel={t('inbox.cancel')}
          placeholder={t('inbox.filter.search')}
          aria-label={t('inbox.filter.search')}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            size="sm"
            variant="filter"
            aria-label={t('inbox.filter.channel')}
            value={filters.channel ?? ''}
            className="w-auto min-w-0 rounded-full"
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
            className="w-auto min-w-0 rounded-full"
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
          <FilterToggle
            pressed={filters.unread === true}
            onPressed={(on) => onFilters({ unread: on ? true : undefined })}
          >
            {t('inbox.filter.unread')}
          </FilterToggle>
          <FilterToggle
            pressed={filters.closed === true}
            onPressed={(on) => onFilters({ closed: on ? true : undefined })}
          >
            {t('inbox.filter.closed')}
          </FilterToggle>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {list.isPending ? (
          <ul className="space-y-1 p-2" aria-busy="true" aria-label={t('inbox.loading')}>
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <li key={n} className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
                <Skeleton className="size-10 shrink-0 rounded-full" />
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
    <ul ref={listRef} aria-label={t('inbox.list.label')} className="space-y-0.5 p-2">
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
    <li data-flip-key={item.id} className={cn(arrived && 'alive-in')}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'alive-press flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left',
          'motion-safe:duration-fast motion-safe:transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
          selected ? 'bg-selected text-selected-foreground' : 'hover:bg-accent',
        )}
      >
        <span className="relative shrink-0">
          <ContactAvatar
            id={item.contact.id}
            name={item.contact.name}
            url={item.contact.avatarUrl}
            size="lg"
          />
          {unread ? (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary"
            />
          ) : null}
        </span>
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
                'ml-auto shrink-0 text-2xs',
                unread ? 'font-semibold text-foreground' : 'text-muted-foreground',
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
                  'ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-2xs font-semibold text-primary-foreground tabular-nums',
                  countChanged && 'alive-pop',
                )}
                aria-label={t('inbox.list.unread', { n: String(item.unreadCount) })}
              >
                {item.unreadCount}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="shrink-0 font-medium">{t(`inbox.channel.${item.channel}`)}</span>
            {item.contact.stage === 'visitor' ? null : (
              <StatusBadge tone={stageTone(item.contact.stage)} className="shrink-0">
                {t(`inbox.stage.${item.contact.stage}`)}
              </StatusBadge>
            )}
            <span aria-hidden="true">·</span>
            <span className="truncate">{owner}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** A filter that is on or off, as a pill beside the selects. */
function FilterToggle({
  pressed,
  onPressed,
  children,
}: {
  readonly pressed: boolean;
  readonly onPressed: (on: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressed(!pressed)}
      className={cn(
        'inline-flex h-control-sm items-center gap-1 rounded-full border px-3 text-sm',
        'motion-safe:duration-fast motion-safe:transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        pressed
          ? 'border-transparent bg-primary text-primary-foreground'
          : 'border-input bg-background text-foreground hover:bg-accent',
      )}
    >
      {pressed ? <Check aria-hidden="true" className="size-3.5" /> : null}
      {children}
    </button>
  );
}
