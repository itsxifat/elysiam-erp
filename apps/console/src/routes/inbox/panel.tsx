import type { CustomerPhoneView } from '@elysium/contracts/customers';
import {
  Button,
  ConfirmDialog,
  DateTime,
  Dialog,
  ErrorState,
  Input,
  Label,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Money,
  Select,
  Skeleton,
  StatusBadge,
  buttonVariants,
  cn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ChevronDown,
  ExternalLink,
  IdCard,
  MapPin,
  NotebookPen,
  Phone,
  Pin,
  Plus,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Tags,
  Trash2,
  UserPlus,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { CallButton } from '../calls/call-button.js';
import { customersPath } from '../customers/customers-nav.js';
import { isOrdersKey, useOrdersT } from '../orders/messages.js';
import { listAreas } from '../orders/api.js';
import { ordersPath } from '../orders/paths.js';
import { typedMobile } from '../people/api.js';
import {
  AddressDialog,
  AddressList,
  DetailsDialog,
  DetailsList,
  type AddressDraft,
} from '../people/customer-details.js';
import { usePeopleT } from '../people/messages.js';
import { AddNumber, NumbersList } from '../people/numbers-card.js';
import type { PersonActions } from '../people/person-actions.js';
import {
  addCustomerAddress,
  addCustomerPhone,
  addInterest,
  addNote,
  getPanel,
  INBOX_KEY,
  linkCustomer,
  removeCustomerAddress,
  removeInterest,
  replaceCustomerAddress,
  retireCustomerPhone,
  saveAddress,
  saveCustomer,
  savePhone,
  setStage,
  setTags,
  unlinkCustomer,
  updateCustomer,
  updateCustomerPhone,
  type ConversationItem,
  type PanelView,
} from './api.js';
import { ContactAvatar } from './avatar.js';
import { displayPhone, districtsOf, parseTags, priceRange, stageTone, thanasOf } from './logic.js';
import { useInboxT } from './messages.js';
import { useOwnerGuard } from './owner-guard.js';
import { useLoadMore, useProductSearch } from './product-search.js';
import { ProductThumb } from './product-thumb.js';
import { SellPanel } from './sell-panel.js';

/**
 * The customer panel beside a thread (M42, D-738 to D-742; M49, D-890 to D-895): who this is, in a
 * header with their number and the quick actions, then three tabs that keep the work organised:
 *
 * - **Customer**: the buyer the chat is linked to, as customer management keeps them (details,
 *   every number with the staff's notes, the address book, orders), edited from here; or, before
 *   the link, the numbers and addresses found in the chat, the people already on the number and
 *   Save as new customer.
 * - **Order**: the side card, the draft order with its product picker (M44b) and the products of
 *   interest, every search listing every match as it scrolls.
 * - **Notes**: the buyer's pinned note and the chat's dated notes.
 *
 * Every save goes through the conversation, so on someone else's it asks first (D-737). Money is
 * `<Money>`; nothing here has, or could show, a cost.
 */

type Tab = 'customer' | 'order' | 'notes';
const TABS: readonly Tab[] = ['customer', 'order', 'notes'];

export function ContactPanel({
  conversation,
  me,
}: {
  readonly conversation: ConversationItem;
  readonly me: string | null;
}) {
  const t = useInboxT();
  const ids = useId();
  const panel = useQuery({
    queryKey: [...INBOX_KEY, 'panel', conversation.id],
    queryFn: () => getPanel(conversation.id),
  });

  return (
    <aside
      aria-labelledby={`${ids}-title`}
      className="inbox-panel relative min-h-0 overflow-y-auto"
    >
      <h2 id={`${ids}-title`} className="sr-only">
        {t('inbox.panel.label')}
      </h2>
      {panel.isPending ? (
        <div className="space-y-3 p-4" aria-busy="true" aria-label={t('inbox.loading')}>
          <div className="flex items-center gap-3">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : panel.isError ? (
        <div className="p-4">
          <ErrorState
            title={t('inbox.errorTitle')}
            detail={panel.error instanceof ApiError ? panel.error.message : t('inbox.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void panel.refetch()}>
                {t('inbox.retry')}
              </Button>
            }
          />
        </div>
      ) : (
        <PanelBody view={panel.data} conversation={conversation} me={me} />
      )}
    </aside>
  );
}

// --- the frame ----------------------------------------------------------------------------------

/** One card of the panel: an icon, a title (and count), an action, and its content. */
function Section({
  icon: Icon,
  title,
  count,
  action,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="inbox-card">
      <header className="flex items-center gap-2 px-3.5 pt-3">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <h3 id={id} className="flex-1 truncate text-sm font-semibold">
          {title}
          {count === undefined || count === 0 ? null : (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">
              {count}
            </span>
          )}
        </h3>
        {action}
      </header>
      <div className="px-3.5 pt-2 pb-3">{children}</div>
    </section>
  );
}

/** A small action in a card's header. */
function HeaderAction({
  icon: Icon,
  children,
  onClick,
}: {
  readonly icon: LucideIcon;
  readonly children: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <Button variant="ghost" size="sm" className="-mr-2 h-7 px-2 text-xs" onClick={onClick}>
      <Icon aria-hidden="true" className="size-3.5" />
      {children}
    </Button>
  );
}

/** What the panel's writes refresh: this chat everywhere, and the buyer wherever they show. */
function useRefresh(id: string, customerId: string | null) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'panel', id] }),
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'thread', id] }),
      queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] }),
      ...(customerId === null
        ? []
        : [
            queryClient.invalidateQueries({ queryKey: ['people', customerId] }),
            queryClient.invalidateQueries({ queryKey: ['customers'] }),
          ]),
    ]);
  }, [queryClient, id, customerId]);
}

type Guard = (action: (acknowledged: boolean) => Promise<unknown>) => Promise<void>;

/**
 * The linked buyer's actions through this conversation (D-890): the customer card's routes, with
 * the go-ahead on someone else's chat. A write that fails after the go-ahead is reported on the
 * panel (its dialog has already closed); otherwise the dialog that asked shows it.
 */
function useInboxActions(
  id: string,
  guard: Guard,
  refresh: () => Promise<void>,
  report: (message: string) => void,
): PersonActions {
  return useMemo(() => {
    const run = (call: (acknowledged: boolean) => Promise<unknown>) =>
      guard(async (acknowledged) => {
        try {
          await call(acknowledged);
        } catch (error) {
          if (acknowledged) report(messageOf(error));
          throw error;
        }
        await refresh();
      });
    return {
      updateDetails: (body) => run((ack) => updateCustomer(id, body, ack)),
      addPhone: (body) => run((ack) => addCustomerPhone(id, body, ack)),
      updatePhone: (phoneId, body) => run((ack) => updateCustomerPhone(id, phoneId, body, ack)),
      retirePhone: (phoneId, body) => run((ack) => retireCustomerPhone(id, phoneId, body, ack)),
      addAddress: (body) => run((ack) => addCustomerAddress(id, body, ack)),
      replaceAddress: (addressId, body) =>
        run((ack) => replaceCustomerAddress(id, addressId, body, ack)),
      removeAddress: (addressId) => run((ack) => removeCustomerAddress(id, addressId, ack)),
    };
  }, [id, guard, refresh, report]);
}

function messageOf(cause: unknown): string {
  return cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause);
}

interface Ctx {
  readonly view: PanelView;
  readonly conversation: ConversationItem;
  readonly id: string;
  readonly mayWrite: boolean;
  readonly busy: boolean;
  /** A write on the chat's own contact (number, address, stage, tags, notes, interests). */
  readonly run: (action: (acknowledged: boolean) => Promise<unknown>) => void;
  readonly guard: Guard;
  readonly refresh: () => Promise<void>;
  readonly actions: PersonActions | null;
  readonly onTab: (tab: Tab) => void;
}

function PanelBody({
  view,
  conversation,
  me,
}: {
  readonly view: PanelView;
  readonly conversation: ConversationItem;
  readonly me: string | null;
}) {
  const t = useInboxT();
  const ability = useAbility();
  const ids = useId();
  const { guard, dialog } = useOwnerGuard(conversation, me);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('customer');
  const [hint, setHint] = useState(false);
  const mayWrite = ability.can('update', 'Conversation');
  const maySell = ability.can('create', 'Order');
  const id = conversation.id;
  const customerId = view.customer?.id ?? null;
  const refresh = useRefresh(id, customerId);
  const actions = useInboxActions(id, guard, refresh, setError);

  const save = useMutation({
    mutationFn: async (action: (acknowledged: boolean) => Promise<unknown>) => {
      setError(null);
      await guard(async (acknowledged) => {
        await action(acknowledged);
        await refresh();
      });
    },
    onError: (cause) => setError(messageOf(cause)),
  });

  const ctx: Ctx = {
    view,
    conversation,
    id,
    mayWrite,
    busy: save.isPending,
    run: (action) => save.mutate(action),
    guard,
    refresh,
    actions: mayWrite && view.customer?.card != null ? actions : null,
    onTab: setTab,
  };

  return (
    <div className="pb-4">
      <PanelHeader ctx={ctx} />
      <TabBar
        tab={tab}
        onTab={setTab}
        hint={hint && tab !== 'order'}
        notes={view.notes.length}
        idBase={ids}
      />
      {error === null ? null : (
        <p
          role="alert"
          className="mx-2 mt-3 rounded-lg bg-destructive-subtle px-3 py-2 text-sm text-destructive-subtle-foreground"
        >
          {error}
        </p>
      )}
      <div
        role="tabpanel"
        id={`${ids}-customer`}
        aria-labelledby={`${ids}-tab-customer`}
        hidden={tab !== 'customer'}
        className="space-y-3 p-3"
      >
        <CustomerTab ctx={ctx} />
      </div>
      <div
        role="tabpanel"
        id={`${ids}-order`}
        aria-labelledby={`${ids}-tab-order`}
        hidden={tab !== 'order'}
        className="space-y-3 p-3"
      >
        {maySell ? (
          <Section icon={ShoppingCart} title={t('inbox.panel.newOrder')}>
            <SellPanel
              conversation={conversation}
              me={me}
              view={view}
              onShow={() => setTab('order')}
              onHint={setHint}
            />
          </Section>
        ) : null}
        <InterestsSection ctx={ctx} />
        {maySell ? (
          <Link
            to={ordersPath('/orders/new')}
            search={{ conversation: id } as never}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'w-full')}
          >
            <ExternalLink aria-hidden className="size-4" />
            {t('inbox.panel.orderDesk')}
          </Link>
        ) : null}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-notes`}
        aria-labelledby={`${ids}-tab-notes`}
        hidden={tab !== 'notes'}
        className="space-y-3 p-3"
      >
        <NotesTab ctx={ctx} />
      </div>
      {dialog}
    </div>
  );
}

/** Customer, Order, Notes: a segmented control, arrow keys between them (WAI-ARIA tabs). */
function TabBar({
  tab,
  onTab,
  hint,
  notes,
  idBase,
}: {
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly hint: boolean;
  readonly notes: number;
  readonly idBase: string;
}) {
  const t = useInboxT();
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({
    customer: null,
    order: null,
    notes: null,
  });
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    const target =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = TABS[Math.min(Math.max(target, 0), TABS.length - 1)] ?? 'customer';
    onTab(next);
    refs.current[next]?.focus();
  };
  const label: Record<Tab, string> = {
    customer: t('inbox.panel.tab.customer'),
    order: t('inbox.panel.tab.order'),
    notes: t('inbox.panel.tab.notes'),
  };
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-background px-3 py-2">
      <div
        role="tablist"
        aria-label={t('inbox.panel.tabs')}
        onKeyDown={onKey}
        className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {TABS.map((value) => (
          <button
            key={value}
            ref={(element) => {
              refs.current[value] = element;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`${idBase}-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => onTab(value)}
            className={cn(
              'relative inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-sm',
              'motion-safe:duration-fast motion-safe:transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              tab === value
                ? 'border-border bg-background font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label[value]}
            {value === 'notes' && notes > 0 ? (
              <span className="text-xs text-muted-foreground tabular-nums">{notes}</span>
            ) : null}
            {value === 'order' && hint ? (
              <span className="alive-pop flex size-2 rounded-full bg-primary">
                <span className="sr-only">{t('inbox.panel.tab.newHint')}</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- the header ---------------------------------------------------------------------------------

function PanelHeader({ ctx }: { readonly ctx: Ctx }) {
  const t = useInboxT();
  const ability = useAbility();
  const { view, conversation, id, mayWrite, busy, run, guard, onTab } = ctx;
  const card = view.customer?.card ?? null;
  const name = card?.name ?? view.contact.name ?? t('inbox.unknownPerson');
  const phone = card?.phone ?? view.contact.phone;
  const stage = view.contact.stage;
  return (
    <header className="space-y-3 bg-background px-4 pt-4 pb-3">
      <div className="flex items-start gap-3">
        <ContactAvatar
          id={conversation.contact.id}
          name={name}
          url={conversation.contact.avatarUrl}
          size="xl"
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="truncate text-base font-semibold" title={name}>
            {name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t(`inbox.channel.${conversation.channel}`)}
            {conversation.contact.handle === null ? '' : ` · @${conversation.contact.handle}`}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {mayWrite ? (
              <StageMenu
                stage={stage}
                busy={busy}
                onPick={(value) => run((ack) => setStage(id, value, ack))}
              />
            ) : (
              <StatusBadge tone={stageTone(stage)}>{t(`inbox.stage.${stage}`)}</StatusBadge>
            )}
            {card === null ? null : (
              <span className="inline-flex items-center gap-1 text-xs text-success-subtle-foreground">
                <UserRoundCheck aria-hidden="true" className="size-3.5" />
                {t('inbox.panel.linked')}
              </span>
            )}
          </div>
        </div>
      </div>
      {phone === null ? null : (
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
          <Phone aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-sm font-medium tabular-nums">{displayPhone(phone)}</span>
          {mayWrite ? (
            <CallButton
              target={{ conversationId: id, phone }}
              phone={phone}
              label={name}
              size="icon"
              guard={guard}
            />
          ) : null}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        {ability.can('create', 'Order') ? (
          <Button
            size="sm"
            className={card === null ? 'col-span-2' : undefined}
            onClick={() => onTab('order')}
          >
            <ShoppingCart aria-hidden="true" />
            {t('inbox.panel.createOrder')}
          </Button>
        ) : null}
        {card !== null && ability.can('read', 'Customer') ? (
          <Link
            to={customersPath(`/customers/${card.id}`)}
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
          >
            <IdCard aria-hidden className="size-4" />
            {t('inbox.panel.openCustomer')}
          </Link>
        ) : null}
      </div>
    </header>
  );
}

function StageMenu({
  stage,
  busy,
  onPick,
}: {
  readonly stage: PanelView['contact']['stage'];
  readonly busy: boolean;
  readonly onPick: (stage: 'lead' | 'not_qualified' | 'fraud' | 'auto') => void;
}) {
  const t = useInboxT();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={`${t('inbox.panel.stage')}: ${t(`inbox.stage.${stage}`)}`}
          className="inline-flex items-center gap-0.5 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          <StatusBadge tone={stageTone(stage)}>
            {t(`inbox.stage.${stage}`)}
            <ChevronDown aria-hidden="true" className="ml-0.5 size-3" />
          </StatusBadge>
        </button>
      </MenuTrigger>
      <MenuContent align="start" className="w-64">
        {(['lead', 'not_qualified', 'fraud', 'auto'] as const).map((value) => (
          <MenuItem key={value} onSelect={() => onPick(value)} destructive={value === 'fraud'}>
            {t(`inbox.stage.${value}`)}
          </MenuItem>
        ))}
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('inbox.panel.stageAuto')}</p>
      </MenuContent>
    </Menu>
  );
}

// --- the Customer tab ---------------------------------------------------------------------------

function CustomerTab({ ctx }: { readonly ctx: Ctx }) {
  const customer = ctx.view.customer;
  return customer !== null && customer.card !== null ? (
    <LinkedCustomer ctx={ctx} customer={customer} card={customer.card} />
  ) : (
    <NotLinked ctx={ctx} />
  );
}

type LinkedView = NonNullable<PanelView['customer']>;
type Card = NonNullable<LinkedView['card']>;

function LinkedCustomer({
  ctx,
  customer,
  card,
}: {
  readonly ctx: Ctx;
  readonly customer: LinkedView;
  readonly card: Card;
}) {
  const t = useInboxT();
  const tp = usePeopleT();
  const [editing, setEditing] = useState(false);
  const [addingAddress, setAddingAddress] = useState<AddressDraft | null | undefined>(undefined);
  const [addingPhone, setAddingPhone] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const { view, id, mayWrite, guard, refresh, actions } = ctx;
  const known = new Set(card.phones.map((phone) => phone.phone));
  const foundPhones = view.phonesFound.filter((found) => !known.has(found.phone));
  const foundAddresses = view.addressesFound.filter(
    (found) =>
      !card.addresses.some(
        (saved) =>
          saved.thanaId === found.thanaId &&
          saved.addressLine.trim().toLowerCase() === found.line.trim().toLowerCase(),
      ),
  );

  const call = (phone: CustomerPhoneView) =>
    mayWrite ? (
      <CallButton
        target={{ conversationId: id, phone: phone.phone }}
        phone={phone.phone}
        label={card.name}
        size="icon"
        className="size-7"
        guard={guard}
      />
    ) : null;

  return (
    <>
      <OverviewSection customer={customer} segment={card.segment} />

      <Section
        icon={IdCard}
        title={tp('people.details.title')}
        action={
          actions === null ? undefined : (
            <HeaderAction icon={NotebookPen} onClick={() => setEditing(true)}>
              {tp('people.details.edit')}
            </HeaderAction>
          )
        }
      >
        <DetailsList person={card} compact />
      </Section>

      <Section
        icon={Phone}
        title={tp('people.numbers.title')}
        count={card.phones.filter((phone) => phone.retired === null).length}
      >
        <NumbersList
          customerId={card.id}
          phones={card.phones}
          actions={actions}
          variant="panel"
          call={call}
        />
        {foundPhones.length === 0 || actions === null ? null : (
          <FoundStrip label={t('inbox.panel.foundInChat')}>
            {foundPhones.map((found) => (
              <Button
                key={found.phone}
                size="sm"
                variant="outline"
                className="h-7 rounded-full px-2.5 text-xs"
                onClick={() => setAddingPhone(found.phone)}
              >
                <Plus aria-hidden="true" className="size-3.5" />
                <span className="tabular-nums">{displayPhone(found.phone)}</span>
              </Button>
            ))}
          </FoundStrip>
        )}
      </Section>

      <Section
        icon={MapPin}
        title={tp('people.addresses.title')}
        count={card.addresses.length}
        action={
          actions === null ? undefined : (
            <HeaderAction icon={Plus} onClick={() => setAddingAddress(null)}>
              {tp('people.addresses.add')}
            </HeaderAction>
          )
        }
      >
        <AddressList addresses={card.addresses} actions={actions} compact />
        {foundAddresses.length === 0 || actions === null ? null : (
          <FoundStrip label={t('inbox.panel.foundInChat')}>
            {foundAddresses.map((found) => (
              <button
                key={`${String(found.thanaId)}-${found.line}`}
                type="button"
                onClick={() =>
                  setAddingAddress({
                    districtId: found.districtId,
                    thanaId: found.thanaId,
                    area: null,
                    addressLine: found.line,
                  })
                }
                className="flex w-full items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Plus
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="block font-medium">
                    {found.thanaName}, {found.districtName}
                  </span>
                  <span className="block break-words text-muted-foreground">{found.line}</span>
                </span>
              </button>
            ))}
          </FoundStrip>
        )}
      </Section>

      <OrdersSection ctx={ctx} customer={customer} />

      <ChatTagsSection ctx={ctx} />

      {mayWrite ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setUnlinking(true)}
          >
            {t('inbox.panel.notThem')}
          </Button>
        </div>
      ) : null}

      {editing && actions !== null ? (
        <DetailsDialog person={card} actions={actions} onClose={() => setEditing(false)} />
      ) : null}
      {addingAddress !== undefined && actions !== null ? (
        <AddressDialog
          actions={actions}
          {...(addingAddress === null ? {} : { draft: addingAddress })}
          onClose={() => setAddingAddress(undefined)}
        />
      ) : null}
      {addingPhone !== null && actions !== null ? (
        <AddNumber
          actions={actions}
          phone={`0${addingPhone.slice(4)}`}
          onClose={() => setAddingPhone(null)}
        />
      ) : null}
      <ConfirmDialog
        open={unlinking}
        onOpenChange={setUnlinking}
        title={t('inbox.panel.notThemTitle')}
        description={t('inbox.panel.notThemDetail')}
        confirmLabel={t('inbox.panel.notThem')}
        cancelLabel={t('inbox.cancel')}
        closeLabel={t('inbox.cancel')}
        onConfirm={async () => {
          await guard(async (ack) => {
            await unlinkCustomer(id, ack);
            await refresh();
          });
        }}
      />
    </>
  );
}

function FoundStrip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mt-3 space-y-1.5 border-t border-border pt-2">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles aria-hidden="true" className="size-3.5" />
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function OverviewSection({
  customer,
  segment,
}: {
  readonly customer: LinkedView;
  readonly segment: string | null;
}) {
  const t = useInboxT();
  const { locale } = useLocale();
  const tiles: [string, ReactNode][] = [
    [t('inbox.panel.orders'), customer.orders],
    [t('inbox.panel.delivered'), customer.delivered],
    [t('inbox.panel.returned'), customer.returned],
    [t('inbox.panel.spent'), <Money key="spent" poisha={customer.spentPoisha} locale={locale} />],
  ];
  return (
    <section aria-label={t('inbox.panel.overview')} className="inbox-card overflow-hidden">
      <dl className="grid grid-cols-2 gap-px bg-border">
        {tiles.map(([name, value]) => (
          <div key={name} className="bg-card px-3.5 py-2.5">
            <dt className="text-xs text-muted-foreground">{name}</dt>
            <dd className="mt-0.5 text-base font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {customer.lastOrderAt === null && segment === null ? null : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3.5 py-2 text-xs text-muted-foreground">
          {customer.lastOrderAt === null ? null : (
            <span>
              {t('inbox.panel.lastOrder')} <DateTime value={customer.lastOrderAt} dateOnly />
            </span>
          )}
          {segment === null ? null : (
            <span className="inline-flex items-center gap-1">
              <Sparkles aria-hidden="true" className="size-3" />
              {segment.replace(/_/g, ' ')}
            </span>
          )}
        </p>
      )}
    </section>
  );
}

function OrdersSection({ ctx, customer }: { readonly ctx: Ctx; readonly customer: LinkedView }) {
  const t = useInboxT();
  const tOrders = useOrdersT();
  const ability = useAbility();
  const { locale } = useLocale();
  return (
    <Section
      icon={ShoppingBag}
      title={t('inbox.panel.recentOrders')}
      count={customer.recentOrders.length}
      action={
        ability.can('create', 'Order') ? (
          <HeaderAction icon={Plus} onClick={() => ctx.onTab('order')}>
            {t('inbox.panel.newOrder')}
          </HeaderAction>
        ) : undefined
      }
    >
      {customer.recentOrders.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inbox.panel.noOrders')}</p>
      ) : (
        <ul className="space-y-0.5">
          {customer.recentOrders.map((order) => {
            const status = `orders.status.${order.status}`;
            return (
              <li key={order.id}>
                <Link
                  to={ordersPath(`/orders/${order.id}`)}
                  className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium tabular-nums">{order.orderNo}</span>
                    <span className="block text-xs text-muted-foreground">
                      <DateTime value={order.createdAt} dateOnly />
                    </span>
                  </span>
                  <StatusBadge tone="neutral">
                    {isOrdersKey(status) ? tOrders(status) : order.status.replace(/_/g, ' ')}
                  </StatusBadge>
                  <span className="w-20 shrink-0 text-right">
                    <Money poisha={order.codAmountPoisha} locale={locale} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** The chat's own labels: the inbox's tags, apart from the buyer's (D-739). */
function ChatTagsSection({ ctx }: { readonly ctx: Ctx }) {
  const t = useInboxT();
  const ids = useId();
  const { view, mayWrite, busy, run, id } = ctx;
  const [tags, setTagsText] = useState(view.contact.tags.join(', '));
  if (!mayWrite && view.contact.tags.length === 0) return null;
  return (
    <Section icon={Tags} title={t('inbox.panel.chatTags')}>
      {mayWrite ? (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            run((ack) => setTags(id, parseTags(tags), ack));
          }}
        >
          <Label htmlFor={`${ids}-tags`} className="sr-only">
            {t('inbox.panel.chatTags')}
          </Label>
          <div className="flex gap-2">
            <Input
              id={`${ids}-tags`}
              value={tags}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder={t('inbox.panel.tagsPlaceholder')}
              aria-describedby={`${ids}-tags-hint`}
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              {t('inbox.save')}
            </Button>
          </div>
          <p id={`${ids}-tags-hint`} className="text-xs text-muted-foreground">
            {t('inbox.panel.tagsHint')}
          </p>
        </form>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {view.contact.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Before the link: the numbers in the chat, the people on the saved one, and Save as customer. */
function NotLinked({ ctx }: { readonly ctx: Ctx }) {
  const t = useInboxT();
  const { view, id, mayWrite, busy, run } = ctx;
  return (
    <>
      <section className="inbox-card px-3.5 py-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary"
          >
            <UserPlus className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t('inbox.panel.notCustomer')}</p>
            <p className="text-xs text-muted-foreground">{t('inbox.panel.notCustomerDetail')}</p>
          </div>
        </div>
        {mayWrite ? (
          <div className="mt-3">
            <SaveCustomerButton ctx={ctx} wide />
          </div>
        ) : null}
      </section>

      <Section icon={Phone} title={t('inbox.panel.phonesFound')}>
        {view.phonesFound.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('inbox.panel.phonesNone')}</p>
        ) : (
          <ul className="space-y-1.5">
            {view.phonesFound.map((found) => (
              <li key={found.phone} className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium tabular-nums">
                  {displayPhone(found.phone)}
                </span>
                {found.matchesCustomer ? (
                  <StatusBadge tone="info">{t('inbox.panel.matchesCustomer')}</StatusBadge>
                ) : null}
                {found.saved ? (
                  <StatusBadge tone="success">{t('inbox.panel.phoneSaved')}</StatusBadge>
                ) : mayWrite ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 rounded-full px-2.5 text-xs"
                    disabled={busy}
                    onClick={() => run((ack) => savePhone(id, found.phone, ack))}
                  >
                    {t('inbox.panel.savePhone', { phone: displayPhone(found.phone) })}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {view.candidates.length === 0 ? null : (
        <Section
          icon={UserRoundCheck}
          title={t('inbox.panel.peopleOnNumber')}
          count={view.candidates.length}
        >
          <ul className="space-y-1.5">
            {view.candidates.map((person) => (
              <li
                key={person.customerId}
                className="flex items-start gap-2.5 rounded-lg border border-border px-2.5 py-2"
              >
                <ContactAvatar id={person.customerId} name={person.name} url={null} size="sm" />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{person.name}</span>
                    {person.suggested ? (
                      <StatusBadge tone="info">{t('inbox.panel.suggested')}</StatusBadge>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('inbox.panel.ordersCount', { n: String(person.orders) })}
                    {person.note === null ? '' : ` · ${person.note}`}
                  </p>
                </div>
                {mayWrite ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 text-xs"
                    disabled={busy}
                    onClick={() => run((ack) => linkCustomer(id, person.customerId, ack))}
                  >
                    {t('inbox.panel.thisIsThem')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <ContactAddressSection
        // A saved address (one click from the chat, or typed) starts the form again from it.
        key={JSON.stringify(view.contact.address)}
        ctx={ctx}
      />
      <ChatTagsSection ctx={ctx} />
    </>
  );
}

/** Save the chat's person as a new customer (D-892): a name and their mobile, then linked. */
function SaveCustomerButton({ ctx, wide = false }: { readonly ctx: Ctx; readonly wide?: boolean }) {
  const t = useInboxT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant={wide ? 'primary' : 'outline'}
        className={wide ? 'w-full' : undefined}
        onClick={() => setOpen(true)}
      >
        <UserPlus aria-hidden="true" />
        {t('inbox.panel.saveAsCustomer')}
      </Button>
      {open ? <SaveCustomerDialog ctx={ctx} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SaveCustomerDialog({ ctx, onClose }: { readonly ctx: Ctx; readonly onClose: () => void }) {
  const t = useInboxT();
  const id = useId();
  const { view } = ctx;
  const startPhone = view.contact.phone ?? view.phonesFound[0]?.phone ?? null;
  const [name, setName] = useState(view.contact.name ?? '');
  const [phone, setPhone] = useState(startPhone === null ? '' : `0${startPhone.slice(4)}`);
  const mobile = typedMobile(phone);
  const save = useMutation({
    mutationFn: () =>
      ctx.guard(async (ack) => {
        await saveCustomer(ctx.id, { name: name.trim(), phone: mobile ?? phone }, ack);
        await ctx.refresh();
      }),
    onSuccess: onClose,
  });
  const ready = name.trim() !== '' && mobile !== null;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('inbox.panel.saveTitle')}
      description={t('inbox.panel.saveDetail')}
      closeLabel={t('inbox.cancel')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('inbox.cancel')}
          </Button>
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {t('inbox.panel.saveAsCustomer')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`} required>
            {t('inbox.panel.name')}
          </Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-phone`} required>
            {t('inbox.panel.number')}
          </Label>
          <Input
            id={`${id}-phone`}
            type="tel"
            inputMode="tel"
            value={phone}
            className="tabular-nums"
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive-text">
            {messageOf(save.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The chat contact's own address (before the link): from the chat in one click, or typed. */
function ContactAddressSection({ ctx }: { readonly ctx: Ctx }) {
  const t = useInboxT();
  const ids = useId();
  const { view, mayWrite, busy, run, id } = ctx;
  const areas = useQuery({
    queryKey: ['orders', 'areas'],
    queryFn: listAreas,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const saved = view.contact.address;
  const [district, setDistrict] = useState<number | null>(saved?.districtId ?? null);
  const [thana, setThana] = useState<number | null>(saved?.thanaId ?? null);
  const [area, setArea] = useState(saved?.area ?? '');
  const [line, setLine] = useState(saved?.addressLine ?? '');
  const all = areas.data?.areas ?? [];
  const districts = districtsOf(all);
  const thanas = thanasOf(all, district);
  const ready = district !== null && thana !== null && line.trim().length >= 3;

  return (
    <Section icon={MapPin} title={t('inbox.panel.address')}>
      {view.addressesFound.length === 0 ? null : (
        <ul className="mb-3 space-y-1.5" aria-label={t('inbox.panel.addressesFound')}>
          {view.addressesFound.map((found) => (
            <li
              key={found.thanaId}
              className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2"
            >
              <Sparkles
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {found.thanaName}, {found.districtName}
                </p>
                <p className="text-xs break-words text-muted-foreground">{found.line}</p>
              </div>
              {mayWrite ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  disabled={busy || found.line.length < 3}
                  onClick={() =>
                    run((ack) =>
                      saveAddress(
                        id,
                        {
                          districtId: found.districtId,
                          thanaId: found.thanaId,
                          addressLine: found.line,
                        },
                        ack,
                      ),
                    )
                  }
                >
                  {t('inbox.panel.useAddress')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          run((ack) =>
            saveAddress(
              id,
              {
                districtId: district,
                thanaId: thana,
                ...(area.trim() === '' ? {} : { area: area.trim() }),
                addressLine: line.trim(),
              },
              ack,
            ),
          );
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-district`}>{t('inbox.panel.district')}</Label>
            <Select
              id={`${ids}-district`}
              size="sm"
              value={district === null ? '' : String(district)}
              placeholder={t('inbox.panel.chooseDistrict')}
              disabled={!mayWrite || areas.isPending}
              onValueChange={(value) => {
                setDistrict(value === '' ? null : Number(value));
                setThana(null);
              }}
              options={districts.map((entry) => ({ value: String(entry.id), label: entry.name }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-thana`}>{t('inbox.panel.thana')}</Label>
            <Select
              id={`${ids}-thana`}
              size="sm"
              value={thana === null ? '' : String(thana)}
              placeholder={t('inbox.panel.chooseThana')}
              disabled={!mayWrite || district === null}
              onValueChange={(value) => setThana(value === '' ? null : Number(value))}
              options={thanas.map((entry) => ({ value: String(entry.id), label: entry.name }))}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-area`}>{t('inbox.panel.area')}</Label>
          <Input
            id={`${ids}-area`}
            value={area}
            onChange={(event) => setArea(event.target.value)}
            disabled={!mayWrite}
            maxLength={160}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-line`}>{t('inbox.panel.addressLine')}</Label>
          <Input
            id={`${ids}-line`}
            value={line}
            onChange={(event) => setLine(event.target.value)}
            disabled={!mayWrite}
            maxLength={500}
          />
        </div>
        {mayWrite ? (
          <Button type="submit" size="sm" variant="outline" disabled={!ready || busy}>
            {t('inbox.panel.saveAddress')}
          </Button>
        ) : null}
      </form>
    </Section>
  );
}

// --- the Notes tab ------------------------------------------------------------------------------

function NotesTab({ ctx }: { readonly ctx: Ctx }) {
  const t = useInboxT();
  const ids = useId();
  const { view, mayWrite, busy, run, id } = ctx;
  const [text, setText] = useState('');
  const pinned = view.customer?.card?.pinnedNote ?? null;
  return (
    <>
      {pinned === null ? null : (
        <section
          aria-label={t('inbox.panel.pinned')}
          className="rounded-xl bg-warning-subtle px-3.5 py-3 text-warning-subtle-foreground"
        >
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            <Pin aria-hidden="true" className="size-3.5" />
            {t('inbox.panel.pinned')}
          </p>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">{pinned.body}</p>
          <p className="mt-1 text-xs">
            {pinned.by.name ?? t('inbox.someone')} · <DateTime value={pinned.at} compact />
          </p>
        </section>
      )}
      <Section icon={NotebookPen} title={t('inbox.panel.notes')} count={view.notes.length}>
        {mayWrite ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const body = text.trim();
              if (body === '') return;
              run(async (ack) => {
                await addNote(id, body, ack);
                setText('');
              });
            }}
          >
            <label htmlFor={`${ids}-note`} className="sr-only">
              {t('inbox.panel.notePlaceholder')}
            </label>
            <textarea
              id={`${ids}-note`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={t('inbox.panel.notePlaceholder')}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={busy || text.trim() === ''}>
                {t('inbox.panel.addNote')}
              </Button>
            </div>
          </form>
        ) : null}
        {view.notes.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('inbox.panel.noNotes')}</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {view.notes.map((note) => (
              <li key={note.id} className="rounded-lg bg-muted px-3 py-2">
                <p className="text-sm break-words whitespace-pre-wrap">{note.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {note.author.name ?? t('inbox.someone')} · <DateTime value={note.at} compact />
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}

// --- the Order tab's products of interest --------------------------------------------------------

function InterestsSection({ ctx }: { readonly ctx: Ctx }) {
  const t = useInboxT();
  const { locale } = useLocale();
  const ids = useId();
  const { view, mayWrite, busy, run, id } = ctx;
  const [q, setQ] = useState('');
  const term = q.trim();
  const searching = mayWrite && term.length >= 2;
  const found = useProductSearch(term, searching);
  const results = useRef<HTMLUListElement>(null);
  const sentinel = useRef<HTMLLIElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = found;
  const more = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  useLoadMore(results, sentinel, more, searching && hasNextPage);
  const chosen = new Set(view.interests.map((interest) => interest.productId));

  return (
    <Section icon={Sparkles} title={t('inbox.panel.interests')} count={view.interests.length}>
      {mayWrite ? (
        <div className="space-y-2">
          <Label htmlFor={`${ids}-search`} className="sr-only">
            {t('inbox.panel.interestSearch')}
          </Label>
          <Input
            id={`${ids}-search`}
            type="search"
            value={q}
            placeholder={t('inbox.panel.interestSearch')}
            onChange={(event) => setQ(event.target.value)}
            autoComplete="off"
            className="rounded-full"
          />
          {!searching ? null : found.isPending ? (
            <p className="text-xs text-muted-foreground">{t('inbox.loading')}</p>
          ) : found.items.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('inbox.panel.interestNone', { q: term })}
            </p>
          ) : (
            <>
              <p className="text-2xs text-muted-foreground tabular-nums" aria-live="polite">
                {hasNextPage
                  ? t('inbox.panel.resultsShown', { n: String(found.items.length) })
                  : t('inbox.panel.resultsAll', { n: String(found.items.length) })}
              </p>
              <ul
                ref={results}
                aria-label={t('inbox.panel.interestSearch')}
                aria-busy={isFetchingNextPage}
                className="inbox-results space-y-0.5 rounded-xl border border-border bg-background p-1"
              >
                {found.items.map((product) => (
                  <li
                    key={product.id}
                    className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-accent"
                  >
                    <ProductThumb fileId={product.imageFileId} alt="" size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{product.name}</span>
                      {product.minPricePoisha === null ? null : (
                        <span className="block text-xs text-muted-foreground">
                          <Money poisha={product.minPricePoisha} locale={locale} />
                        </span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={busy || chosen.has(product.id)}
                      onClick={() =>
                        run(async (ack) => {
                          await addInterest(id, { productId: product.id }, ack);
                          setQ('');
                        })
                      }
                    >
                      <Plus aria-hidden className="size-3.5" />
                      {t('inbox.panel.interestPick')}
                    </Button>
                  </li>
                ))}
                <li ref={sentinel} aria-hidden="true" className="h-px" />
                {isFetchingNextPage ? (
                  <li className="py-1.5 text-center text-xs text-muted-foreground">
                    {t('inbox.panel.loadingMore')}
                  </li>
                ) : null}
              </ul>
            </>
          )}
        </div>
      ) : null}
      {view.interests.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('inbox.panel.noInterests')}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {view.interests.map((interest) => {
            const product = interest.product;
            const range =
              product === null ? null : priceRange(product.minPricePoisha, product.maxPricePoisha);
            return (
              <li key={interest.id} className="flex gap-3">
                <ProductThumb fileId={product?.imageFileId ?? null} alt={product?.name ?? ''} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                      {product?.name ?? t('inbox.unknownPerson')}
                    </p>
                    {mayWrite ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="size-7"
                        aria-label={t('inbox.remove')}
                        disabled={busy}
                        onClick={() => run((ack) => removeInterest(id, interest.id, ack))}
                      >
                        <Trash2 aria-hidden className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                  {product?.status === 'archived' ? (
                    <StatusBadge tone="neutral">{t('inbox.panel.archived')}</StatusBadge>
                  ) : null}
                  {range === null ? null : (
                    <p className="text-sm">
                      <Money poisha={range.min} locale={locale} />
                      {range.max === null ? null : (
                        <>
                          {' – '}
                          <Money poisha={range.max} locale={locale} />
                        </>
                      )}
                    </p>
                  )}
                  <ul className="flex flex-wrap gap-1">
                    {(product?.variants ?? []).map((variant) => (
                      <li key={variant.skuId}>
                        <StatusBadge tone={variant.available > 0 ? 'success' : 'neutral'}>
                          {variant.label === '' ? variant.code : variant.label}
                          {' · '}
                          {variant.available > 0
                            ? t('inbox.panel.inStock', { n: String(variant.available) })
                            : t('inbox.panel.outOfStock')}
                        </StatusBadge>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
