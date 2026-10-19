import {
  Button,
  ErrorState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  StatusBadge,
  cn,
} from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronDown,
  CircleCheck,
  Clock,
  Paperclip,
  UserRound,
} from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import '../../alive/alive.css';
import { prefersReducedMotion, useArrivals, useNow } from '../../alive/motion.js';
import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  act,
  getTeam,
  getThread,
  handOver,
  INBOX_KEY,
  markRead,
  reply,
  type AttachmentView,
  type MessageView,
  type OutboundStatus,
  type ThreadView,
} from './api.js';
import { ContactAvatar } from './avatar.js';
import { Composer } from './composer.js';
import { useSingleKeys } from './inbox-keys.js';
import { failureKey, stageTone } from './logic.js';
import { useInboxT } from './messages.js';
import { useOwnerGuard } from './owner-guard.js';
import { ContactPanel } from './panel.js';
import { clockTime, dayLabel, hasBangla, relativeTime, threadItems } from './thread-logic.js';
import { dayText, timeText } from './time-text.js';
// M45: voice messages, kept pictures and calls in the thread, and the composer's recorder.
import { drawsAttachment, InboxAttachment } from './voice/inbox-attachment.js';
import { ComposerVoice } from './voice/voice-recorder.js';

/**
 * One conversation: the thread in the middle and the customer panel beside it (M42; M44a
 * D-765, D-767). The thread sticks to the newest message unless the person scrolled up to
 * read, in which case a "New messages" pill brings them back; only messages that arrive while
 * it is open slide in. Below the large breakpoint the thread and the panel take turns.
 */

export type Pane = 'thread' | 'customer';

/**
 * What a thread's attachments may do (M45): a call-back goes through the owner check (D-737) and
 * refreshes the thread, like the thread's own actions.
 */
interface ThreadActions {
  readonly guard: (action: (acknowledged: boolean) => Promise<unknown>) => Promise<void>;
  readonly onChanged: () => Promise<void>;
}
const ThreadActionsContext = createContext<ThreadActions | null>(null);

export function Conversation({
  id,
  me,
  onBack,
  onPane,
}: {
  readonly id: string;
  readonly me: string | null;
  readonly onBack: () => void;
  readonly onPane: (pane: Pane) => void;
}) {
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
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] }),
        queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'unread'] }),
      ]),
    );
  }, [unreadMine, id, queryClient]);

  if (thread.isPending) {
    return (
      <section
        className="inbox-thread flex min-h-0 flex-col"
        aria-busy="true"
        aria-label={t('inbox.loading')}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <div className="inbox-chat flex-1 space-y-3 px-4 py-4">
          <Skeleton className="h-10 w-2/3 rounded-xl" />
          <Skeleton className="ml-auto h-10 w-48 rounded-xl" />
          <Skeleton className="h-16 w-2/3 rounded-xl" />
          <Skeleton className="ml-auto h-10 w-40 rounded-xl" />
        </div>
      </section>
    );
  }
  if (thread.isError) {
    return (
      <section className="inbox-thread p-4">
        <ErrorState
          title={t('inbox.errorTitle')}
          detail={thread.error instanceof ApiError ? thread.error.message : t('inbox.errorDetail')}
          action={
            <Button size="sm" variant="outline" onClick={() => void thread.refetch()}>
              {t('inbox.retry')}
            </Button>
          }
        />
      </section>
    );
  }
  return (
    <>
      <Thread view={thread.data} me={me} onBack={onBack} onPane={onPane} />
      <ContactPanel conversation={thread.data.conversation} me={me} />
    </>
  );
}

function Thread({
  view,
  me,
  onBack,
  onPane,
}: {
  readonly view: ThreadView;
  readonly me: string | null;
  readonly onBack: () => void;
  readonly onPane: (pane: Pane) => void;
}) {
  const t = useInboxT();
  const ids = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const conversation = view.conversation;
  const { guard, dialog } = useOwnerGuard(conversation, me);
  const [error, setError] = useState<string | null>(null);
  const mayWrite = ability.can('update', 'Conversation');
  const mayReassign = ability.can('update', 'ConversationAssignment');
  const now = useNow();

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'thread', conversation.id] }),
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] }),
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'panel', conversation.id] }),
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'unread'] }),
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

  const sendReply = (text: string, sent: () => void) =>
    guard(async (acknowledged) => {
      await reply(conversation.id, { id: crypto.randomUUID(), text }, acknowledged);
      sent();
      await refresh();
    });

  const owner = conversation.assignedTo;
  const mayTake = mayWrite && owner?.userId !== me && (owner === null || mayReassign);
  const take = () => run((ack) => act(conversation.id, 'take', ack));
  const close = () => run((ack) => act(conversation.id, 'close', ack));
  useSingleKeys({
    a: mayTake ? take : undefined,
    e: mayWrite && conversation.status === 'open' ? close : undefined,
  });

  const ownerLine =
    owner === null
      ? t('inbox.thread.unassigned')
      : owner.userId === me
        ? t('inbox.thread.assignedYou')
        : t('inbox.thread.assignedOther', { name: owner.name ?? t('inbox.someone') });
  const replyWindow = conversation.window;
  const windowLine = replyWindow.open
    ? t('inbox.thread.windowOpen', { time: shortTime(replyWindow.closesAt) })
    : replyWindow.reason === 'never_wrote'
      ? t('inbox.thread.windowNever')
      : t('inbox.thread.windowExpired', { time: shortTime(replyWindow.closesAt) });
  const name = conversation.contact.name ?? t('inbox.unknownPerson');

  return (
    <section aria-labelledby={`${ids}-name`} className="inbox-thread flex min-h-0 min-w-0 flex-col">
      <header className="space-y-2 border-b border-border bg-background px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            className="inbox-small-only rounded-full"
            aria-label={t('inbox.thread.back')}
            onClick={onBack}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
          <ContactAvatar
            id={conversation.contact.id}
            name={conversation.contact.name}
            url={conversation.contact.avatarUrl}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                id={`${ids}-name`}
                lang={hasBangla(name) ? 'bn' : undefined}
                className="truncate text-base font-semibold"
              >
                {name}
              </h2>
              <StatusBadge tone={stageTone(conversation.contact.stage)} className="shrink-0">
                {t(`inbox.stage.${conversation.contact.stage}`)}
              </StatusBadge>
              {conversation.status === 'closed' ? (
                <StatusBadge tone="neutral" className="shrink-0">
                  {t('inbox.thread.closed')}
                </StatusBadge>
              ) : null}
            </div>
            <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
              <span>{t(`inbox.channel.${conversation.channel}`)}</span>
              {conversation.contact.handle === null ? null : (
                <span className="truncate">@{conversation.contact.handle}</span>
              )}
              <span aria-hidden="true">·</span>
              <span className="truncate">{ownerLine}</span>
            </p>
          </div>
          {mayWrite ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {owner?.userId === me ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => run((ack) => act(conversation.id, 'release', ack))}
                >
                  {t('inbox.thread.release')}
                </Button>
              ) : mayTake ? (
                // Taking over a colleague's conversation is a supervisor's (D-737).
                <Button
                  size="sm"
                  className="alive-press rounded-full"
                  aria-keyshortcuts="A"
                  onClick={take}
                >
                  {t('inbox.thread.take')}
                </Button>
              ) : null}
              {owner === null || owner.userId === me || mayReassign ? (
                <HandOverMenu
                  onPick={(userId) => run((ack) => handOver(conversation.id, userId, ack))}
                />
              ) : null}
              {conversation.status === 'open' ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-full"
                  aria-keyshortcuts="E"
                  aria-label={t('inbox.thread.close')}
                  title={t('inbox.thread.close')}
                  onClick={close}
                >
                  <CircleCheck aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => run((ack) => act(conversation.id, 'reopen', ack))}
                >
                  {t('inbox.thread.reopen')}
                </Button>
              )}
            </div>
          ) : null}
          <Button
            variant="outline"
            size="icon-sm"
            className="inbox-small-only rounded-full"
            aria-label={t('inbox.thread.showCustomer')}
            onClick={() => onPane('customer')}
          >
            <UserRound aria-hidden="true" />
          </Button>
        </div>
        {conversation.contact.stage === 'fraud' ? (
          <p
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
          >
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            {t('inbox.fraudBanner')}
          </p>
        ) : null}
      </header>

      <ThreadActionsContext.Provider value={{ guard, onChanged: refresh }}>
        <Messages view={view} me={me} now={now} />
      </ThreadActionsContext.Provider>

      <footer className="space-y-1.5 border-t border-border bg-background px-4 pt-2 pb-2">
        <p
          className={cn(
            'flex items-center gap-1.5 text-xs',
            replyWindow.open
              ? 'text-muted-foreground'
              : 'rounded-lg bg-warning-subtle px-2.5 py-1.5 text-warning-subtle-foreground',
          )}
        >
          <Clock aria-hidden="true" className="size-3.5 shrink-0" />
          {windowLine}
        </p>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
        {mayWrite ? (
          <Composer
            conversation={conversation}
            disabled={!replyWindow.open}
            onSend={sendReply}
            describedBy={`${ids}-hint`}
            actions={
              <ComposerVoice
                conversationId={conversation.id}
                guard={guard}
                disabled={!replyWindow.open}
                onSent={refresh}
                onError={setError}
              />
            }
          />
        ) : null}
        <p id={`${ids}-hint`} className="px-1 text-2xs text-muted-foreground">
          {t('inbox.thread.sendHint')}
        </p>
      </footer>
      {dialog}
    </section>
  );
}

/** Below this many pixels from the end, the thread counts as read to the end. */
const NEAR_END_PX = 72;

function Messages({
  view,
  me,
  now,
}: {
  readonly view: ThreadView;
  readonly me: string | null;
  readonly now: number;
}) {
  const t = useInboxT();
  const scroller = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [seen, setSeen] = useState(view.messages.length);
  const messages = view.messages;
  const arrivals = useArrivals(messages.map((message) => message.id));
  const items = threadItems(messages);
  const last = messages[messages.length - 1];
  const contact = view.conversation.contact;

  // Stick to the newest: at the end, or after our own reply, follow it down; otherwise leave
  // the person where they are reading, and the pill counts what came in.
  const followed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || last === undefined || followed.current === last.id) return;
    const first = followed.current === null;
    followed.current = last.id;
    const mine = last.direction === 'outbound' && last.sentBy?.userId === me;
    if (!first && !atEnd && !mine) return;
    const top = element.scrollHeight;
    if (typeof element.scrollTo === 'function') {
      element.scrollTo({ top, behavior: first || prefersReducedMotion() ? 'auto' : 'smooth' });
    } else {
      element.scrollTop = top;
    }
  }, [last, atEnd, me]);

  const onScroll = () => {
    const element = scroller.current;
    if (element === null) return;
    const end = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END_PX;
    setAtEnd(end);
    if (end) setSeen(messages.length);
  };

  const unseen = atEnd ? 0 : Math.max(0, messages.length - seen);

  return (
    <div className="inbox-chat relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="relative h-full overflow-y-auto px-4 py-3">
        <ol aria-label={t('inbox.thread.label')} className="inbox-messages">
          {items.map((item) =>
            item.kind === 'day' ? (
              <li key={item.key} className="inbox-day text-xs">
                <span className="rounded-full border border-border bg-background px-2.5 py-0.5">
                  {dayText(dayLabel(item.day, now), t)}
                </span>
              </li>
            ) : (
              item.messages.map((message, index) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  position={position(index, item.messages.length)}
                  arrived={arrivals.has(message.id)}
                  me={me}
                  now={now}
                  contact={contact}
                />
              ))
            ),
          )}
        </ol>
      </div>
      {unseen > 0 ? (
        <button
          type="button"
          onClick={() => {
            const element = scroller.current;
            if (element === null) return;
            element.scrollTo({
              top: element.scrollHeight,
              behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            });
          }}
          className={cn(
            'alive-pop absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full',
            'bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-popover',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none',
          )}
        >
          <ArrowDown aria-hidden="true" className="size-3.5" />
          {t('inbox.thread.jumpNew')} · {unseen}
        </button>
      ) : null}
    </div>
  );
}

type Position = 'single' | 'first' | 'middle' | 'last';

function position(index: number, count: number): Position {
  if (count === 1) return 'single';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

function MessageRow({
  message,
  position: pos,
  arrived,
  me,
  now,
  contact,
}: {
  readonly message: MessageView;
  readonly position: Position;
  readonly arrived: boolean;
  readonly me: string | null;
  readonly now: number;
  readonly contact: ThreadView['conversation']['contact'];
}) {
  const t = useInboxT();
  const inbound = message.direction === 'inbound';
  const side = inbound ? 'start' : 'end';
  const lastOfGroup = pos === 'last' || pos === 'single';
  const firstOfGroup = pos === 'first' || pos === 'single';
  const failure = message.error === null ? null : failureKey(message.error.code);
  const colleague =
    !inbound && message.sentBy !== null && message.sentBy.userId !== me ? message.sentBy : null;

  return (
    <li
      data-side={side}
      data-pos={pos}
      className={cn('inbox-msg', arrived && (inbound ? 'alive-in-start' : 'alive-in-end'))}
    >
      {inbound ? (
        lastOfGroup ? (
          <ContactAvatar id={contact.id} name={contact.name} url={contact.avatarUrl} size="sm" />
        ) : (
          <span className="inbox-gutter" aria-hidden="true" />
        )
      ) : null}
      <div className="inbox-msg-body">
        {firstOfGroup && !inbound && (colleague !== null || message.sentBy === null) ? (
          <p className="px-1 text-xs text-muted-foreground">
            {message.sentBy === null
              ? t('inbox.thread.fromMeta')
              : t('inbox.thread.sentBy', { name: colleague?.name ?? t('inbox.someone') })}
          </p>
        ) : null}
        <div
          className="inbox-bubble text-sm"
          data-side={side}
          data-pos={pos}
          title={clockTime(message.at)}
        >
          <MessageBody message={message} />
        </div>
        {lastOfGroup || message.status === 'failed' ? (
          <p className="inbox-meta text-xs">
            <time dateTime={message.at}>{timeText(relativeTime(message.at, now), t)}</time>
            {inbound ? null : <StatusTick status={message.status as OutboundStatus} />}
          </p>
        ) : null}
        {failure === null ? null : (
          <p className="px-1 text-xs text-destructive-text">
            {'code' in failure ? t(failure.key, { code: failure.code }) : t(failure.key)}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * What a message holds, drawn by its kind: the render point for every kind of message. M45's
 * kinds (a voice message's player, a kept picture, a call's record) are drawn in `Attachment`.
 */
function MessageBody({ message }: { readonly message: MessageView }) {
  return (
    <>
      {message.text === null ? null : (
        <p
          lang={hasBangla(message.text) ? 'bn' : undefined}
          className="break-words whitespace-pre-wrap"
        >
          {message.text}
        </p>
      )}
      {message.attachments.map((attachment, index) => (
        <Attachment key={index} attachment={attachment} />
      ))}
    </>
  );
}

function Attachment({ attachment }: { readonly attachment: AttachmentView }) {
  const t = useInboxT();
  const [broken, setBroken] = useState(false);
  const actions = useContext(ThreadActionsContext);
  // M45 (D-780, D-784): a voice message, a picture the inbox kept, or a call.
  if (actions !== null && drawsAttachment(attachment)) {
    return (
      <div className="mt-1">
        <InboxAttachment
          attachment={attachment}
          guard={actions.guard}
          onChanged={actions.onChanged}
        />
      </div>
    );
  }
  switch (attachment.type) {
    case 'image':
      if (attachment.url !== undefined && !broken) {
        return (
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inbox-photo focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <img
              src={attachment.url}
              alt={attachment.caption ?? t('inbox.thread.image')}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setBroken(true)}
            />
          </a>
        );
      }
      return <FileAttachment attachment={attachment} />;
    default:
      return <FileAttachment attachment={attachment} />;
  }
}

function FileAttachment({ attachment }: { readonly attachment: AttachmentView }) {
  const t = useInboxT();
  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs">
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
  );
}

const TICKS: Readonly<Record<OutboundStatus, typeof Check>> = {
  queued: Clock,
  sent: Check,
  delivered: CheckCheck,
  read: CheckCheck,
  failed: AlertTriangle,
};

/** Sending, Sent ✓, Delivered ✓✓, Read ✓✓ in the accent, Not sent: each step pops in. */
function StatusTick({ status }: { readonly status: OutboundStatus }) {
  const t = useInboxT();
  const Icon = TICKS[status];
  return (
    <span
      key={status}
      className={cn(
        'alive-pop inline-flex items-center gap-1',
        status === 'read' && 'text-primary',
        status === 'failed' && 'text-destructive-text',
      )}
    >
      {t(`inbox.status.${status}`)}
      <Icon aria-hidden="true" className="size-3.5" />
    </span>
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
        <Button size="sm" variant="outline" className="rounded-full">
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
