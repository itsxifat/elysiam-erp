import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Monogram,
  PageHeader,
  PermissionGate,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  cn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, ChevronDown, MessagesSquare, Paperclip, Send } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { ApiError } from '../../api.js';
import { useAbility, useSession } from '../../auth/session.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import {
  act,
  getTeam,
  getThread,
  INBOX_KEY,
  listConversations,
  markRead,
  reply,
  handOver,
  type ConversationItem,
  type MessageView,
  type ThreadView,
} from './api.js';
import {
  CHANNEL_KINDS,
  CONTACT_STAGES,
  failureKey,
  inboxSearchSchema,
  stageTone,
  statusTone,
  type InboxSearch,
} from './logic.js';
import { useInboxT } from './messages.js';
import { useOwnerGuard } from './owner-guard.js';
import { ContactPanel } from './panel.js';

/**
 * The unified inbox (M42, D-730 to D-749): every channel in one list on the left, the thread in
 * the middle, the customer panel on the right.
 *
 * Live, the way the approvals inbox is: §19's events carry ids only, so an event invalidates the
 * queries it concerns and the server answers again through `serializeFor`; nothing from the
 * socket is shown as it arrived. A write on someone else's conversation asks first (D-737).
 */

const INBOX_EVENTS = [
  'inbox.message_received',
  'inbox.message_status',
  'inbox.conversation_changed',
  'inbox.owner_overridden',
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
  const navigate = (next: { readonly search: (prev: InboxSearch) => InboxSearch }) =>
    routerNavigate({ to: '.', search: next.search(search) as never });
  const queryClient = useQueryClient();
  const session = useSession();
  const me = session.context?.userId ?? null;
  const [notice, setNotice] = useState<string | null>(null);

  const status = useRealtime({
    events: INBOX_EVENTS,
    enabled: session.context !== null,
    onEvent: (name, payload) => {
      const id = (payload as { conversationId?: unknown } | null)?.conversationId;
      void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] });
      if (typeof id === 'string') {
        void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'thread', id] });
        void queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'panel', id] });
      }
      if (name === 'inbox.owner_overridden') {
        const body = payload as { action?: unknown } | null;
        setNotice(
          t('inbox.owner.overridden', {
            name: t('inbox.someone'),
            action: typeof body?.action === 'string' ? body.action.replace(/[._]/g, ' ') : '',
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

  const select = (id: string) =>
    void navigate({ search: (prev: InboxSearch) => ({ ...prev, c: id }) });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('inbox.title')}
        description={t('inbox.subtitle')}
        meta={
          <StatusBadge tone={status === 'connected' ? 'success' : 'warning'}>
            {status === 'connected' ? t('inbox.live') : t('inbox.offline')}
          </StatusBadge>
        }
      />
      {notice === null ? null : (
        <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      <div className="grid overflow-hidden rounded-lg border border-border bg-card lg:h-[calc(100vh-13rem)] lg:grid-cols-4">
        <ConversationList
          filters={filters}
          selected={search.c ?? null}
          me={me}
          onSelect={select}
          onFilters={(next) =>
            void navigate({ search: (prev: InboxSearch) => ({ ...prev, ...next }) })
          }
        />
        {search.c === undefined ? (
          <div className="flex items-center justify-center border-l border-border p-6 lg:col-span-3">
            <EmptyState
              icon={MessagesSquare}
              title={t('inbox.thread.pick')}
              detail={t('inbox.thread.pickDetail')}
            />
          </div>
        ) : (
          <Conversation key={search.c} id={search.c} me={me} />
        )}
      </div>
    </div>
  );
}

// --- the list -----------------------------------------------------------------------------------

function ConversationList({
  filters,
  selected,
  me,
  onSelect,
  onFilters,
}: {
  readonly filters: Omit<InboxSearch, 'c'>;
  readonly selected: string | null;
  readonly me: string | null;
  readonly onSelect: (id: string) => void;
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

  const views = [
    ['all', t('inbox.view.all')],
    ['mine', t('inbox.view.mine')],
    ['unassigned', t('inbox.view.unassigned')],
  ] as const;

  return (
    <section aria-labelledby={`${ids}-title`} className="flex min-h-0 flex-col">
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
          <div className="space-y-2 p-3" aria-busy="true" aria-label={t('inbox.loading')}>
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-16 w-full" />
            ))}
          </div>
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
          <ul aria-label={t('inbox.list.label')}>
            {list.data.items.map((item) => (
              <ConversationRow
                key={item.id}
                item={item}
                me={me}
                selected={item.id === selected}
                onSelect={() => onSelect(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ConversationRow({
  item,
  me,
  selected,
  onSelect,
}: {
  readonly item: ConversationItem;
  readonly me: string | null;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const t = useInboxT();
  const name = item.contact.name ?? t('inbox.unknownPerson');
  const owner =
    item.assignedTo === null
      ? t('inbox.list.nobody')
      : item.assignedTo.userId === me
        ? t('inbox.list.you')
        : (item.assignedTo.name ?? t('inbox.someone'));
  return (
    <li className="border-b border-border">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'block w-full px-3 py-2.5 text-left',
          'motion-safe:duration-fast hover:bg-accent motion-safe:transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
          selected && 'bg-selected text-selected-foreground',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            <DateTime value={item.lastMessageAt} compact />
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className="truncate text-sm text-muted-foreground">{item.lastPreview ?? ''}</span>
          {item.unreadCount > 0 ? (
            <span
              className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums"
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
      </button>
    </li>
  );
}

// --- one conversation: the thread and the panel -----------------------------------------------

function Conversation({ id, me }: { readonly id: string; readonly me: string | null }) {
  const t = useInboxT();
  const queryClient = useQueryClient();
  const thread = useQuery({
    queryKey: [...INBOX_KEY, 'thread', id],
    queryFn: () => getThread(id),
    // While a reply is still sending, ask again now and then in case the socket is down.
    refetchInterval: (query) =>
      query.state.data?.messages.some((message) => message.status === 'queued') === true
        ? 3_000
        : false,
  });

  // The owner has read it once it is on their screen.
  const conversation = thread.data?.conversation;
  const unreadMine =
    conversation !== undefined &&
    conversation.unreadCount > 0 &&
    conversation.assignedTo?.userId === me;
  useEffect(() => {
    if (!unreadMine) return;
    void markRead(id).then(() =>
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] }),
    );
  }, [unreadMine, id, queryClient]);

  if (thread.isPending) {
    return (
      <div
        className="space-y-3 border-l border-border p-4 lg:col-span-3"
        aria-busy="true"
        aria-label={t('inbox.loading')}
      >
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (thread.isError) {
    return (
      <div className="border-l border-border p-4 lg:col-span-3">
        <ErrorState
          title={t('inbox.errorTitle')}
          detail={thread.error instanceof ApiError ? thread.error.message : t('inbox.errorDetail')}
          action={
            <Button size="sm" variant="outline" onClick={() => void thread.refetch()}>
              {t('inbox.retry')}
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <>
      <Thread view={thread.data} me={me} />
      <ContactPanel conversation={thread.data.conversation} me={me} />
    </>
  );
}

function Thread({ view, me }: { readonly view: ThreadView; readonly me: string | null }) {
  const t = useInboxT();
  const ids = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const conversation = view.conversation;
  const { guard, dialog } = useOwnerGuard(conversation, me);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const mayWrite = ability.can('update', 'Conversation');

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [view.messages.length]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'thread', conversation.id] }),
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] }),
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'panel', conversation.id] }),
    ]);
  };
  const failed = (cause: unknown) =>
    setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause));

  const run = (action: (acknowledged: boolean) => Promise<unknown>) => {
    setError(null);
    void guard(async (acknowledged) => {
      await action(acknowledged);
      await refresh();
    }).catch(failed);
  };

  const send = useMutation({
    mutationFn: async () => {
      const text = draft.trim();
      if (text === '') return;
      setError(null);
      await guard(async (acknowledged) => {
        await reply(conversation.id, { id: crypto.randomUUID(), text }, acknowledged);
        setDraft('');
        await refresh();
      });
    },
    onError: failed,
  });

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!send.isPending) send.mutate();
    }
  };

  const owner = conversation.assignedTo;
  const ownerLine =
    owner === null
      ? t('inbox.thread.unassigned')
      : owner.userId === me
        ? t('inbox.thread.assignedYou')
        : t('inbox.thread.assignedOther', { name: owner.name ?? t('inbox.someone') });
  const window = conversation.window;
  const windowLine = window.open
    ? t('inbox.thread.windowOpen', { time: shortTime(window.closesAt) })
    : window.reason === 'never_wrote'
      ? t('inbox.thread.windowNever')
      : t('inbox.thread.windowExpired', { time: shortTime(window.closesAt) });

  return (
    <section
      aria-labelledby={`${ids}-name`}
      className="flex min-h-0 min-w-0 flex-col border-l border-border lg:col-span-2"
    >
      <header className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Monogram name={conversation.contact.name ?? '?'} size="sm" />
          <h2 id={`${ids}-name`} className="truncate text-base font-semibold">
            {conversation.contact.name ?? t('inbox.unknownPerson')}
          </h2>
          <StatusBadge tone="neutral">{t(`inbox.channel.${conversation.channel}`)}</StatusBadge>
          <StatusBadge tone={stageTone(conversation.contact.stage)}>
            {t(`inbox.stage.${conversation.contact.stage}`)}
          </StatusBadge>
          {conversation.status === 'closed' ? (
            <StatusBadge tone="neutral">{t('inbox.thread.closed')}</StatusBadge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">{ownerLine}</p>
          {mayWrite ? (
            <div className="ml-auto flex flex-wrap gap-2">
              {owner?.userId === me ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => run((ack) => act(conversation.id, 'release', ack))}
                >
                  {t('inbox.thread.release')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => run((ack) => act(conversation.id, 'take', ack))}>
                  {t('inbox.thread.take')}
                </Button>
              )}
              <HandOverMenu
                onPick={(userId) => run((ack) => handOver(conversation.id, userId, ack))}
              />
              {conversation.status === 'open' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => run((ack) => act(conversation.id, 'close', ack))}
                >
                  {t('inbox.thread.close')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => run((ack) => act(conversation.id, 'reopen', ack))}
                >
                  {t('inbox.thread.reopen')}
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {conversation.contact.stage === 'fraud' ? (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-md bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
          >
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            {t('inbox.fraudBanner')}
          </p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ol aria-label={t('inbox.thread.label')} className="space-y-2">
          {view.messages.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
        </ol>
        <div ref={endRef} />
      </div>

      <footer className="space-y-2 border-t border-border p-3">
        <p
          className={cn(
            'text-xs',
            window.open
              ? 'text-muted-foreground'
              : 'rounded-md bg-warning-subtle px-2 py-1 text-warning-subtle-foreground',
          )}
        >
          {windowLine}
        </p>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
        {mayWrite ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!send.isPending) send.mutate();
            }}
          >
            <label htmlFor={`${ids}-compose`} className="sr-only">
              {t('inbox.thread.compose')}
            </label>
            <textarea
              id={`${ids}-compose`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKey}
              rows={2}
              maxLength={1000}
              disabled={!window.open || send.isPending}
              placeholder={t('inbox.thread.composePlaceholder')}
              aria-describedby={`${ids}-hint`}
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
            />
            <Button type="submit" disabled={!window.open || send.isPending || draft.trim() === ''}>
              <Send aria-hidden className="size-4" />
              {t('inbox.thread.send')}
            </Button>
          </form>
        ) : null}
        <p id={`${ids}-hint`} className="text-xs text-muted-foreground">
          {t('inbox.thread.sendHint')}
        </p>
      </footer>
      {dialog}
    </section>
  );
}

function HandOverMenu({ onPick }: { readonly onPick: (userId: string) => void }) {
  const t = useInboxT();
  const [open, setOpen] = useState(false);
  const team = useQuery({
    queryKey: [...INBOX_KEY, 'team'],
    queryFn: getTeam,
    enabled: open,
    staleTime: 60_000,
  });
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <Button size="sm" variant="outline">
          {t('inbox.thread.handOver')}
          <ChevronDown aria-hidden className="size-4" />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" aria-label={t('inbox.thread.handOverTo')}>
        {team.data === undefined ? (
          <MenuItem disabled>{t('inbox.loading')}</MenuItem>
        ) : (
          team.data.items.map((member) => (
            <MenuItem key={member.userId} onSelect={() => onPick(member.userId)}>
              {member.name}
            </MenuItem>
          ))
        )}
      </MenuContent>
    </Menu>
  );
}

function Bubble({ message }: { readonly message: MessageView }) {
  const t = useInboxT();
  const inbound = message.direction === 'inbound';
  const failure = message.error === null ? null : failureKey(message.error.code);
  return (
    <li className={cn('flex', !inbound && 'justify-end')}>
      <div
        className={cn(
          'max-w-md rounded-lg px-3 py-2 text-sm',
          inbound ? 'bg-muted text-foreground' : 'bg-selected text-selected-foreground',
        )}
      >
        {message.text === null ? null : (
          <p className="break-words whitespace-pre-wrap">{message.text}</p>
        )}
        {message.attachments.map((attachment, index) => (
          <p key={index} className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Paperclip aria-hidden className="size-3.5" />
            {t('inbox.thread.attachment', { type: attachment.type })}
            {attachment.url === undefined ? null : (
              <a
                href={attachment.url}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {t('inbox.thread.openAttachment')}
              </a>
            )}
          </p>
        ))}
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <DateTime value={message.at} compact />
          {inbound ? null : (
            <>
              <StatusBadge tone={statusTone(message.status)}>
                {t(`inbox.status.${message.status}`)}
              </StatusBadge>
              <span>
                {message.sentBy === null
                  ? t('inbox.thread.fromMeta')
                  : t('inbox.thread.sentBy', { name: message.sentBy.name ?? t('inbox.someone') })}
              </span>
            </>
          )}
        </p>
        {failure === null ? null : (
          <p className="mt-1 text-xs text-destructive-text">
            {'code' in failure ? t(failure.key, { code: failure.code }) : t(failure.key)}
          </p>
        )}
      </div>
    </li>
  );
}

/** "11 Oct, 14:05" in Dhaka time, for the window line. */
function shortTime(iso: string | null): string {
  if (iso === null) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
