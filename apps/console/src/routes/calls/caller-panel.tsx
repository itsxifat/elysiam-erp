import type { MessageKey, WorkflowKey } from '@elysium/i18n';
import { talkTime } from '@elysium/domain/telephony';
import {
  Button,
  controlClassName,
  DateTime,
  Monogram,
  Money,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Headphones,
  Pencil,
  Phone,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useLocale } from '../../i18n/locale.js';
import { percentOfBps } from '../courier/courier-ui.js';
import { ordersPath } from '../orders/paths.js';
import {
  fetchCallerPanel,
  getCall,
  pinCustomerNote,
  TELEPHONY_KEY,
  type CallerPanelAnswer,
  type CallerPanelCall,
  type CallerPanelFull,
  type CallerPanelOrder,
  type CallerPanelTarget,
} from './api.js';
import { peopleKey, usePeopleT } from '../people/messages.js';
import { openCallerPanel } from './caller-panel-store.js';
import { ChannelMark } from './channel-mark.js';
import { useTelT, type TelT } from './messages.js';
import { RecordingPlayer } from './recording-player.js';

/**
 * The caller panel (M47, D-860): beside the screen, never over it (non-modal), everything the
 * brand knows of the person on the phone: the note pinned for whoever talks to them next, all
 * their orders, every call with them (who, when, how long, and what was agreed), their phones,
 * emails, addresses, inbox profiles and conversations with each channel's mark (D-861), and the
 * facts the order screens keep. Opened by the console's phone when a call rings or a Call is
 * placed (it then never takes focus, D-843), and by Details on the phone's card, the Calls page
 * and an order's calls. Escape or Close shuts it. Two columns on a wide screen, one otherwise.
 */
export function CallerPanel({
  target,
  auto,
  onClose,
}: {
  readonly target: CallerPanelTarget;
  readonly auto: boolean;
  readonly onClose: () => void;
}) {
  const t = useTelT();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const panelKey = [...TELEPHONY_KEY, 'panel', target] as const;
  // A ringing call may be asked about before Envo's word of it has reached the ERP: an answer
  // that is not yet the whole panel is asked again a few times.
  const panel = useQuery({
    queryKey: panelKey,
    queryFn: () => fetchCallerPanel(target),
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data?.full === false && query.state.dataUpdateCount < 6 ? 2_500 : false,
  });

  useEffect(() => {
    if (!auto) heading.current?.focus();
  }, [auto]);

  // Escape shuts it while focus is inside; the page beside it keeps its own keys.
  const aside = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = aside.current;
    if (element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    element.addEventListener('keydown', onKey);
    return () => element.removeEventListener('keydown', onKey);
  }, [onClose]);

  const answer = panel.data;
  const name =
    answer?.customer?.name ??
    (answer?.full === true && answer.phone !== null
      ? t('tel.panel.unknown')
      : t('tel.panel.caller'));

  return (
    <aside
      ref={aside}
      aria-labelledby={headingId}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-popover motion-safe:animate-in sm:max-w-md xl:max-w-3xl"
    >
      <header className="flex items-start gap-3 border-b border-border p-4">
        <Monogram name={answer?.customer?.name ?? '?'} size="md" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-xs font-medium text-muted-foreground">{t('tel.panel.title')}</p>
          <h2
            ref={heading}
            id={headingId}
            tabIndex={-1}
            className="truncate text-base font-semibold focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {name}
          </h2>
          {answer?.phone == null ? null : (
            <p className="text-sm text-muted-foreground tabular-nums">
              {localNumber(answer.phone)}
            </p>
          )}
          {answer?.full === true && answer.customer?.fraud === true ? (
            <StatusBadge tone="danger">{t('tel.panel.fraud')}</StatusBadge>
          ) : null}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t('tel.panel.close')} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {panel.isPending ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : panel.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {panel.error instanceof ApiError ? panel.error.message : t('tel.failed')}
            </p>
            <Button variant="outline" size="sm" onClick={() => void panel.refetch()}>
              {t('tel.retry')}
            </Button>
          </div>
        ) : answer === undefined ? null : answer.full ? (
          <FullPanel answer={answer} target={target} panelKey={panelKey} />
        ) : (
          <MinimalPanel answer={answer} />
        )}
      </div>
    </aside>
  );
}

/** Someone who sees only today's screen pop: the name and open orders, if anything. */
function MinimalPanel({
  answer,
}: {
  readonly answer: Extract<CallerPanelAnswer, { full: false }>;
}) {
  const t = useTelT();
  if (answer.customer === null) {
    return <p className="text-sm text-muted-foreground">{t('tel.panel.nothing')}</p>;
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('tel.panel.limited')}</p>
      <Block title={t('tel.panel.orders.open')}>
        <OrderRows orders={answer.openOrders} />
      </Block>
    </div>
  );
}

function FullPanel({
  answer,
  target,
  panelKey,
}: {
  readonly answer: CallerPanelFull;
  readonly target: CallerPanelTarget;
  readonly panelKey: readonly unknown[];
}) {
  const t = useTelT();
  return (
    <div className="space-y-5">
      {answer.customer === null ? (
        <p className="text-sm text-muted-foreground">{t('tel.panel.newCaller')}</p>
      ) : (
        <PinnedNote customer={answer.customer} panelKey={panelKey} />
      )}
      <div className="space-y-5 xl:grid xl:grid-cols-[minmax(0,1fr)_17rem] xl:gap-6 xl:space-y-0">
        <div className="min-w-0 space-y-5">
          {answer.customer === null ? null : <Orders answer={answer} target={target} />}
          <Block title={t('tel.panel.calls.title')}>
            {answer.calls.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('tel.panel.calls.none')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {answer.calls.map((call) => (
                  <CallRow key={call.id} call={call} />
                ))}
              </ul>
            )}
          </Block>
        </div>
        <SideColumn answer={answer} target={target} />
      </div>
    </div>
  );
}

/** A titled part of the panel. */
function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

// --- the pinned note ----------------------------------------------------------------------------

function PinnedNote({
  customer,
  panelKey,
}: {
  readonly customer: NonNullable<CallerPanelFull['customer']>;
  readonly panelKey: readonly unknown[];
}) {
  const t = useTelT();
  const id = useId();
  const queryClient = useQueryClient();
  const note = customer.pinnedNote;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note?.body ?? '');
  const save = useMutation({
    mutationFn: () => pinCustomerNote(customer.id, body),
    onSuccess: (result) => {
      queryClient.setQueryData<CallerPanelAnswer>(panelKey, (old) =>
        old?.full === true && old.customer !== null
          ? { ...old, customer: { ...old.customer, pinnedNote: result.pinnedNote } }
          : old,
      );
      setEditing(false);
    },
  });

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-2 rounded-lg border border-border bg-muted/40 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          {t('tel.panel.note.title')}
        </h3>
        {customer.canPin && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setBody(note?.body ?? '');
              save.reset();
              setEditing(true);
            }}
          >
            <Pencil aria-hidden="true" />
            {note === null ? t('tel.panel.note.add') : t('tel.panel.note.edit')}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label htmlFor={`${id}-body`} className="text-sm font-medium">
            {t('tel.panel.note.label')}
          </label>
          <textarea
            id={`${id}-body`}
            value={body}
            rows={3}
            maxLength={2000}
            aria-describedby={`${id}-hint`}
            className={`${controlClassName} h-auto min-h-16 w-full py-2`}
            onChange={(event) => setBody(event.target.value)}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {t('tel.panel.note.hint')}
          </p>
          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {save.error instanceof ApiError ? save.error.message : t('tel.failed')}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t('tel.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? t('tel.saving') : t('tel.save')}
            </Button>
          </div>
        </form>
      ) : note === null ? (
        <p className="text-sm text-muted-foreground">{t('tel.panel.note.empty')}</p>
      ) : (
        <>
          <p className="text-sm whitespace-pre-wrap">{note.body}</p>
          <p className="text-xs text-muted-foreground">
            {t('tel.panel.note.by', { name: note.byName ?? t('tel.panel.someone') })} ·{' '}
            <DateTime value={note.at} compact />
          </p>
        </>
      )}
      {save.isSuccess && !editing ? (
        <p role="status" className="sr-only">
          {t('tel.panel.note.saved')}
        </p>
      ) : null}
    </section>
  );
}

// --- orders ---------------------------------------------------------------------------------------

const STATUS_TONE: Readonly<Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'>> =
  {
    pending: 'warning',
    confirmed: 'info',
    on_hold: 'warning',
    packed: 'info',
    shipped: 'info',
    delivered: 'success',
    partially_delivered: 'success',
    return_in_transit: 'danger',
    returned: 'danger',
    cancelled: 'neutral',
    exchange: 'neutral',
  };

function OrderStatus({ status }: { readonly status: string }) {
  const { t } = useLocale();
  const tone = STATUS_TONE[status];
  return (
    <StatusBadge tone={tone ?? 'neutral'}>
      {tone === undefined ? status : t(`orders.status.${status}` as MessageKey)}
    </StatusBadge>
  );
}

function OrderRows({ orders }: { readonly orders: readonly CallerPanelOrder[] }) {
  const t = useTelT();
  if (orders.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('tel.panel.orders.none')}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {orders.map((order) => (
        <li key={order.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
          <Link
            to={ordersPath(`/orders/${order.id}`)}
            className="font-medium tabular-nums underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {order.orderNo}
          </Link>
          <OrderStatus status={order.status} />
          <span className="text-xs text-muted-foreground">
            <DateTime value={order.createdAt} compact />
          </span>
          <Money poisha={order.codAmountPoisha} className="ml-auto" />
        </li>
      ))}
    </ul>
  );
}

/** All the buyer's orders, newest first, twenty at a time. */
function Orders({
  answer,
  target,
}: {
  readonly answer: CallerPanelFull;
  readonly target: CallerPanelTarget;
}) {
  const t = useTelT();
  const [more, setMore] = useState<readonly CallerPanelOrder[]>([]);
  const [cursor, setCursor] = useState<string | null>(answer.orders.nextCursor);
  const next = useMutation({
    mutationFn: (from: string) => fetchCallerPanel(target, from),
    onSuccess: (page) => {
      if (!page.full) {
        setCursor(null);
        return;
      }
      setMore((shown) => [...shown, ...page.orders.items]);
      setCursor(page.orders.nextCursor);
    },
  });
  return (
    <Block title={t('tel.panel.orders.title')}>
      <OrderRows orders={[...answer.orders.items, ...more]} />
      {next.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {next.error instanceof ApiError ? next.error.message : t('tel.failed')}
        </p>
      ) : null}
      {cursor === null ? null : (
        <Button
          variant="outline"
          size="sm"
          disabled={next.isPending}
          onClick={() => next.mutate(cursor)}
        >
          {next.isPending ? t('tel.loading') : t('tel.panel.orders.more')}
        </Button>
      )}
    </Block>
  );
}

// --- calls --------------------------------------------------------------------------------------

function CallRow({ call }: { readonly call: CallerPanelCall }) {
  const t = useTelT();
  const Icon =
    call.direction === 'inbound'
      ? ArrowDownLeft
      : call.direction === 'internal'
        ? ArrowLeftRight
        : call.direction === 'outbound'
          ? ArrowUpRight
          : Phone;
  const talk =
    call.talkSeconds === null || call.talkSeconds === 0
      ? t('tel.panel.calls.noTalk')
      : t('tel.panel.calls.talk', { time: talkTime(call.talkSeconds) });
  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="sr-only">{t(`tel.direction.${call.direction}`)}</span>
        <span className="font-medium">{call.person?.name ?? t('tel.panel.someone')}</span>
        <span className="text-xs text-muted-foreground">
          <DateTime value={call.occurredAt} compact />
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{talk}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {call.wrapUp === null ? (
          <span className="text-xs text-muted-foreground">{t('tel.panel.calls.notWrapped')}</span>
        ) : (
          <StatusBadge tone={call.wrapUp.result === 'reached' ? 'success' : 'neutral'}>
            {t(`wf.outcome.${call.wrapUp.result}` as WorkflowKey)}
          </StatusBadge>
        )}
        {call.order === null ? null : (
          <Link
            to={ordersPath(`/orders/${call.order.id}`)}
            className="text-xs tabular-nums underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {call.order.orderNo}
          </Link>
        )}
        {call.wrapUp?.callBackAt == null ? null : (
          <span className="text-xs text-muted-foreground">
            {t('tel.panel.calls.callBack')} <DateTime value={call.wrapUp.callBackAt} compact />
          </span>
        )}
      </div>
      {call.wrapUp?.note == null ? null : (
        <p className="whitespace-pre-wrap text-muted-foreground">{call.wrapUp.note}</p>
      )}
      {call.canPlay ? <Listen callId={call.id} /> : null}
    </li>
  );
}

/** The recording, through the Calls page's own player (D-841's scope, D-858's stream). */
function Listen({ callId }: { readonly callId: string }) {
  const t = useTelT();
  const [open, setOpen] = useState(false);
  const call = useQuery({
    queryKey: [...TELEPHONY_KEY, 'calls', callId],
    queryFn: () => getCall(callId),
    enabled: open,
  });
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Headphones aria-hidden="true" />
        {t('tel.panel.calls.listen')}
      </Button>
    );
  }
  if (call.data !== undefined) return <RecordingPlayer call={call.data} />;
  if (call.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {call.error instanceof ApiError ? call.error.message : t('tel.failed')}
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">{t('tel.loading')}</p>;
}

// --- the side column ----------------------------------------------------------------------------

function SideColumn({
  answer,
  target,
}: {
  readonly answer: CallerPanelFull;
  readonly target: CallerPanelTarget;
}) {
  const t = useTelT();
  const customer = answer.customer;
  return (
    <div className="min-w-0 space-y-5">
      {/* M48 (D-887): a number several people use, each with how they use it. */}
      <SharedNumber answer={answer} target={target} />
      <PersonNumbers numbers={answer.numbers} />
      <Block title={t('tel.panel.contact.title')}>
        <dl className="space-y-2 text-sm">
          {answer.phone === null ? null : (
            <Fact label={t('tel.panel.contact.phone')}>
              <span className="tabular-nums">{localNumber(answer.phone)}</span>
            </Fact>
          )}
          {answer.otherPhones.length === 0 ? null : (
            <Fact label={t('tel.panel.contact.otherPhones')}>
              <ul className="space-y-0.5">
                {answer.otherPhones.map((other) => (
                  <li key={other.phone}>
                    <span className="tabular-nums">{localNumber(other.phone)}</span>{' '}
                    <span className="text-xs text-muted-foreground">
                      {other.source === 'order'
                        ? t('tel.panel.contact.fromOrder')
                        : t('tel.panel.contact.fromInbox')}
                    </span>
                  </li>
                ))}
              </ul>
            </Fact>
          )}
          {answer.emails.length === 0 ? null : (
            <Fact label={t('tel.panel.contact.emails')}>
              <ul className="space-y-0.5">
                {answer.emails.map((email) => (
                  <li key={email.email} className="break-all">
                    {email.email}{' '}
                    {email.verified ? (
                      <span className="text-xs text-muted-foreground">
                        {t('tel.panel.contact.verified')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Fact>
          )}
          {answer.addresses.length === 0 ? null : (
            <Fact label={t('tel.panel.contact.addresses')}>
              <ul className="space-y-1.5">
                {answer.addresses.map((address, index) => (
                  <li key={`${address.source}-${String(index)}`}>
                    <span className="block">
                      {[address.addressLine, address.area, address.thana, address.district]
                        .filter((part) => part !== null && part !== '')
                        .join(', ')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {address.source === 'order'
                        ? t('tel.panel.contact.sentTo')
                        : [address.label, address.isDefault ? t('tel.panel.contact.default') : null]
                            .filter((part) => part !== null && part !== '')
                            .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </Fact>
          )}
        </dl>
      </Block>

      <Block title={t('tel.panel.social.title')}>
        {answer.socials.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('tel.panel.social.none')}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {answer.socials.map((social) => (
              <li key={`${social.contactId}-${social.channel}`} className="space-y-0.5">
                <ChannelMark channel={social.channel} className="text-muted-foreground" />
                <span className="block">
                  {social.profileName ?? social.displayName ?? '—'}
                  {social.handle === null ? null : (
                    <span className="text-muted-foreground"> @{social.handle}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title={t('tel.panel.chats.title')}>
        {answer.conversations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('tel.panel.chats.none')}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {answer.conversations.map((conversation) => (
              <li key={conversation.id} className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ChannelMark channel={conversation.channel} labelHidden />
                  <StatusBadge tone={conversation.status === 'open' ? 'info' : 'neutral'}>
                    {conversation.status === 'open'
                      ? t('tel.panel.chats.open')
                      : t('tel.panel.chats.closed')}
                  </StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    <DateTime value={conversation.lastMessageAt} compact />
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {conversation.assignedTo === null
                    ? t('tel.panel.chats.nobody')
                    : t('tel.panel.chats.with', {
                        name: conversation.assignedTo.name ?? t('tel.panel.someone'),
                      })}
                </p>
                {conversation.preview === null ? null : (
                  <p className="line-clamp-2">{conversation.preview}</p>
                )}
                {conversation.canOpen ? (
                  <Link
                    to="/inbox"
                    search={{ c: conversation.id } as never}
                    className="text-xs underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {t('tel.panel.chats.goTo')}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Block>

      {customer === null ? null : <Facts customer={customer} t={t} />}
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Facts({
  customer,
  t,
}: {
  readonly customer: NonNullable<CallerPanelFull['customer']>;
  readonly t: TelT;
}) {
  const { t: appT } = useLocale();
  const { stats } = customer;
  const segmentKey = `customers.segment.${customer.segment ?? ''}` as MessageKey;
  const segment = customer.segment === null ? null : appT(segmentKey);
  return (
    <Block title={t('tel.panel.facts.title')}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <Fact label={t('tel.panel.facts.orders')}>
          <span className="tabular-nums">{stats.orders}</span>
        </Fact>
        <Fact label={t('tel.panel.facts.delivered')}>
          <span className="tabular-nums">{stats.delivered}</span>
        </Fact>
        <Fact label={t('tel.panel.facts.returned')}>
          <span className="tabular-nums">{stats.returned}</span>
        </Fact>
        <Fact label={t('tel.panel.facts.cancelled')}>
          <span className="tabular-nums">{stats.cancelled}</span>
        </Fact>
        <Fact label={t('tel.panel.facts.returnRate')}>
          <span className="tabular-nums">{percentOfBps(stats.returnRateBps)}</span>
        </Fact>
        <Fact label={t('tel.panel.facts.spent')}>
          <Money poisha={stats.spentPoisha} align="start" />
        </Fact>
        <Fact label={t('tel.panel.facts.first')}>
          {stats.firstOrderAt === null ? '—' : <DateTime value={stats.firstOrderAt} dateOnly />}
        </Fact>
        <Fact label={t('tel.panel.facts.last')}>
          {stats.lastOrderAt === null ? '—' : <DateTime value={stats.lastOrderAt} dateOnly />}
        </Fact>
        {segment === null ? null : (
          <Fact label={t('tel.panel.facts.segment')}>
            {segment === segmentKey ? customer.segment : segment}
          </Fact>
        )}
        {customer.tags.length === 0 ? null : (
          <div className="col-span-2">
            <dt className="text-xs text-muted-foreground">{t('tel.panel.facts.tags')}</dt>
            <dd className="flex flex-wrap gap-1 pt-0.5">
              {customer.tags.map((tag) => (
                <StatusBadge key={tag} tone="neutral" className="font-normal">
                  {tag}
                </StatusBadge>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </Block>
  );
}

/** A Bangladeshi mobile as people write it (01…); anything else as it came. */
function localNumber(phone: string): string {
  return /^\+8801\d{9}$/.test(phone) ? `0${phone.slice(4)}` : phone;
}

// --- M48: the person's numbers, and the others on this number (D-870, D-887) --------------------

function PersonNumbers({ numbers }: { readonly numbers: CallerPanelFull['numbers'] }) {
  const t = usePeopleT();
  if (numbers.length === 0) return null;
  return (
    <Block title={t('people.panel.numbers')}>
      <ul className="space-y-2 text-sm">
        {numbers.map((number) => {
          const relation = peopleKey('relation', number.relation);
          return (
            <li key={number.id}>
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="tabular-nums">{localNumber(number.phone)}</span>
                {number.rank === 1 ? (
                  <StatusBadge tone="info">{t('people.numbers.primary')}</StatusBadge>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {relation === null ? number.relation : t(relation)}
                </span>
                {number.needsDetails ? (
                  <StatusBadge tone="warning">{t('people.numbers.needsDetails')}</StatusBadge>
                ) : null}
              </span>
              {number.note === null ? null : (
                <span className="block text-xs text-muted-foreground">{number.note}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function SharedNumber({
  answer,
  target,
}: {
  readonly answer: CallerPanelFull;
  readonly target: CallerPanelTarget;
}) {
  const t = usePeopleT();
  if (answer.sharedWith.length < 2) return null;
  // The panel's own call or number, with the person to show beside it.
  const base: { readonly callId: string } | { readonly phone: string } | null =
    'callId' in target
      ? { callId: target.callId }
      : answer.phone === null
        ? null
        : { phone: answer.phone };
  return (
    <Block title={t('people.panel.sharedTitle', { count: answer.sharedWith.length })}>
      <ul className="space-y-2 text-sm">
        {answer.sharedWith.map((person) => {
          const relation = peopleKey('relation', person.relation);
          return (
            <li key={person.customerId} className="space-y-0.5">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{person.name}</span>
                <span className="text-xs text-muted-foreground">
                  {relation === null ? person.relation : t(relation)}
                </span>
              </span>
              {person.note === null ? null : (
                <span className="block text-xs text-muted-foreground">{person.note}</span>
              )}
              {person.current ? (
                <span className="block text-xs text-muted-foreground">
                  {t('people.panel.showing')}
                </span>
              ) : base === null ? null : (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => openCallerPanel({ ...base, customerId: person.customerId })}
                >
                  {t('people.panel.switch', { name: person.name })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}
