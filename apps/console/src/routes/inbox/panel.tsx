import {
  Button,
  DateTime,
  ErrorState,
  Input,
  Label,
  Money,
  Select,
  Skeleton,
  StatusBadge,
  buttonVariants,
  cn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ImageOff, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { imageUrl } from '../catalog/api.js';
import { listAreas } from '../orders/api.js';
import { ordersPath } from '../orders/paths.js';
import {
  addInterest,
  addNote,
  getPanel,
  INBOX_KEY,
  removeInterest,
  saveAddress,
  savePhone,
  searchProducts,
  setStage,
  setTags,
  type ConversationItem,
  type PanelView,
} from './api.js';
import { displayPhone, districtsOf, parseTags, priceRange, stageTone, thanasOf } from './logic.js';
import { useInboxT } from './messages.js';
import { useOwnerGuard } from './owner-guard.js';

/**
 * The customer panel beside a thread (M42, D-738 to D-742): phones in the chat saved in one
 * click, the address, the matched customer's orders and spend, dated notes, products of
 * interest with today's price and stock, tags and the stage, and Create order.
 *
 * Every save goes through the conversation, so on someone else's it asks first (D-737). Money
 * is `<Money>`; nothing here has, or could show, a cost.
 */
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
      className="min-h-0 overflow-y-auto border-l border-border md:max-h-[calc(100dvh-14rem)]"
    >
      <h2 id={`${ids}-title`} className="sr-only">
        {t('inbox.panel.label')}
      </h2>
      {panel.isPending ? (
        <div className="space-y-3 p-4" aria-busy="true" aria-label={t('inbox.loading')}>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
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

function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const ids = useId();
  return (
    <section aria-labelledby={ids} className="space-y-2 border-b border-border px-4 py-3">
      <h3 id={ids} className="text-xs font-medium text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
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
  const queryClient = useQueryClient();
  const { guard, dialog } = useOwnerGuard(conversation, me);
  const [error, setError] = useState<string | null>(null);
  const mayWrite = ability.can('update', 'Conversation');
  const id = conversation.id;

  const save = useMutation({
    mutationFn: async (action: (acknowledged: boolean) => Promise<unknown>) => {
      setError(null);
      await guard(async (acknowledged) => {
        await action(acknowledged);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'panel', id] }),
          queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'thread', id] }),
          queryClient.invalidateQueries({ queryKey: [...INBOX_KEY, 'list'] }),
        ]);
      });
    },
    onError: (cause) =>
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause)),
  });
  const run = (action: (acknowledged: boolean) => Promise<unknown>) => save.mutate(action);

  return (
    <div>
      {error === null ? null : (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-destructive-text">
          {error}
        </p>
      )}
      <ContactBlock view={view} mayWrite={mayWrite} busy={save.isPending} run={run} id={id} />
      <PhonesBlock view={view} mayWrite={mayWrite} busy={save.isPending} run={run} id={id} />
      <AddressBlock
        // A saved address (one click from the chat, or typed) starts the form again from it.
        key={JSON.stringify(view.contact.address)}
        view={view}
        mayWrite={mayWrite}
        busy={save.isPending}
        run={run}
        id={id}
      />
      <CustomerBlock view={view} />
      <NotesBlock view={view} mayWrite={mayWrite} busy={save.isPending} run={run} id={id} />
      <InterestsBlock view={view} mayWrite={mayWrite} busy={save.isPending} run={run} id={id} />
      {ability.can('create', 'Order') ? (
        <div className="px-4 py-3">
          <Link
            to={ordersPath('/orders/new')}
            search={{ conversation: id } as never}
            className={cn(buttonVariants({ size: 'sm' }), 'w-full')}
          >
            <ShoppingCart aria-hidden className="size-4" />
            {t('inbox.panel.createOrder')}
          </Link>
        </div>
      ) : null}
      {dialog}
    </div>
  );
}

interface BlockProps {
  readonly view: PanelView;
  readonly mayWrite: boolean;
  readonly busy: boolean;
  readonly id: string;
  readonly run: (action: (acknowledged: boolean) => Promise<unknown>) => void;
}

function ContactBlock({ view, mayWrite, busy, run, id }: BlockProps) {
  const t = useInboxT();
  const ids = useId();
  const [tags, setTagsText] = useState(view.contact.tags.join(', '));
  const stage = view.contact.stage;
  return (
    <Block title={t('inbox.panel.contact')}>
      <p className="text-sm font-medium">{view.contact.name ?? t('inbox.unknownPerson')}</p>
      <div className="flex items-center gap-2">
        <StatusBadge tone={stageTone(stage)}>{t(`inbox.stage.${stage}`)}</StatusBadge>
        {mayWrite ? (
          <Select
            size="sm"
            aria-label={t('inbox.panel.stage')}
            value=""
            placeholder={t('inbox.panel.stage')}
            disabled={busy}
            onValueChange={(value) => {
              if (value === '') return;
              run((ack) => setStage(id, value as 'lead' | 'not_qualified' | 'fraud' | 'auto', ack));
            }}
            options={[
              { value: 'lead', label: t('inbox.stage.lead') },
              { value: 'not_qualified', label: t('inbox.stage.not_qualified') },
              { value: 'fraud', label: t('inbox.stage.fraud') },
              { value: 'auto', label: t('inbox.stage.auto') },
            ]}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('inbox.panel.stageAuto')}</p>
      {mayWrite ? (
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            run((ack) => setTags(id, parseTags(tags), ack));
          }}
        >
          <Label htmlFor={`${ids}-tags`}>{t('inbox.panel.tags')}</Label>
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
      ) : view.contact.tags.length === 0 ? null : (
        <p className="text-sm">{view.contact.tags.join(', ')}</p>
      )}
    </Block>
  );
}

function PhonesBlock({ view, mayWrite, busy, run, id }: BlockProps) {
  const t = useInboxT();
  return (
    <Block title={t('inbox.panel.phonesFound')}>
      {view.contact.phone === null ? null : (
        <p className="text-sm">
          <span className="text-muted-foreground">{t('inbox.panel.phone')}: </span>
          <span className="font-medium tabular-nums">{displayPhone(view.contact.phone)}</span>
        </p>
      )}
      {view.phonesFound.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inbox.panel.phonesNone')}</p>
      ) : (
        <ul className="space-y-1.5">
          {view.phonesFound.map((found) => (
            <li key={found.phone} className="flex flex-wrap items-center gap-2">
              <span className="text-sm tabular-nums">{displayPhone(found.phone)}</span>
              {found.matchesCustomer ? (
                <StatusBadge tone="info">{t('inbox.panel.matchesCustomer')}</StatusBadge>
              ) : null}
              {found.saved ? (
                <StatusBadge tone="success">{t('inbox.panel.phoneSaved')}</StatusBadge>
              ) : mayWrite ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
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
    </Block>
  );
}

function AddressBlock({ view, mayWrite, busy, run, id }: BlockProps) {
  const t = useInboxT();
  const ids = useId();
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
    <Block title={t('inbox.panel.address')}>
      {view.addressesFound.length === 0 ? null : (
        <ul className="space-y-2" aria-label={t('inbox.panel.addressesFound')}>
          {view.addressesFound.map((found) => (
            <li key={found.thanaId} className="space-y-1 rounded-md border border-border p-2">
              <p className="text-sm font-medium">
                {found.thanaName}, {found.districtName}
              </p>
              <p className="text-xs break-words text-muted-foreground">{found.line}</p>
              {mayWrite ? (
                <Button
                  size="sm"
                  variant="outline"
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
    </Block>
  );
}

function CustomerBlock({ view }: { readonly view: PanelView }) {
  const t = useInboxT();
  const { locale } = useLocale();
  const customer = view.customer;
  return (
    <Block title={t('inbox.panel.customer')}>
      {customer === null ? (
        <p className="text-sm text-muted-foreground">{t('inbox.panel.noCustomer')}</p>
      ) : (
        <>
          <p className="text-sm font-medium">{customer.name}</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('inbox.panel.orders')}</dt>
            <dd className="text-right tabular-nums">{customer.orders}</dd>
            <dt className="text-muted-foreground">{t('inbox.panel.delivered')}</dt>
            <dd className="text-right tabular-nums">{customer.delivered}</dd>
            <dt className="text-muted-foreground">{t('inbox.panel.returned')}</dt>
            <dd className="text-right tabular-nums">{customer.returned}</dd>
            <dt className="text-muted-foreground">{t('inbox.panel.spent')}</dt>
            <dd className="text-right">
              <Money poisha={customer.spentPoisha} locale={locale} />
            </dd>
          </dl>
          <h4 className="pt-1 text-xs text-muted-foreground">{t('inbox.panel.recentOrders')}</h4>
          {customer.recentOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('inbox.panel.noOrders')}</p>
          ) : (
            <ul className="space-y-1">
              {customer.recentOrders.map((order) => (
                <li key={order.id} className="flex items-center gap-2 text-sm">
                  <Link
                    to={ordersPath(`/orders/${order.id}`)}
                    className="font-medium tabular-nums underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {order.orderNo}
                  </Link>
                  <StatusBadge tone="neutral">{order.status.replace(/_/g, ' ')}</StatusBadge>
                  <span className="ml-auto">
                    <Money poisha={order.codAmountPoisha} locale={locale} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Block>
  );
}

function NotesBlock({ view, mayWrite, busy, run, id }: BlockProps) {
  const t = useInboxT();
  const ids = useId();
  const [text, setText] = useState('');
  return (
    <Block title={t('inbox.panel.notes')}>
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
            rows={2}
            maxLength={2000}
            placeholder={t('inbox.panel.notePlaceholder')}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
          <Button type="submit" size="sm" variant="outline" disabled={busy || text.trim() === ''}>
            {t('inbox.panel.addNote')}
          </Button>
        </form>
      ) : null}
      {view.notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inbox.panel.noNotes')}</p>
      ) : (
        <ul className="space-y-2">
          {view.notes.map((note) => (
            <li key={note.id} className="space-y-0.5">
              <p className="text-sm break-words whitespace-pre-wrap">{note.body}</p>
              <p className="text-xs text-muted-foreground">
                <DateTime value={note.at} compact /> · {note.author.name ?? t('inbox.someone')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function InterestsBlock({ view, mayWrite, busy, run, id }: BlockProps) {
  const t = useInboxT();
  const { locale } = useLocale();
  const ids = useId();
  const [q, setQ] = useState('');
  const term = q.trim();
  const found = useQuery({
    queryKey: ['inbox', 'product-search', term],
    queryFn: () => searchProducts(term),
    enabled: mayWrite && term.length >= 3,
    staleTime: 30_000,
  });
  return (
    <Block title={t('inbox.panel.interests')}>
      {mayWrite ? (
        <div className="space-y-1">
          <Label htmlFor={`${ids}-search`}>{t('inbox.panel.interestSearch')}</Label>
          <Input
            id={`${ids}-search`}
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            autoComplete="off"
          />
          {term.length >= 3 && found.data !== undefined ? (
            <ul className="space-y-1" aria-label={t('inbox.panel.interestSearch')}>
              {found.data.items.slice(0, 6).map((product) => (
                <li key={product.id} className="flex items-center gap-2 text-sm">
                  <span className="truncate">{product.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() =>
                      run(async (ack) => {
                        await addInterest(id, { productId: product.id }, ack);
                        setQ('');
                      })
                    }
                  >
                    <Plus aria-hidden className="size-4" />
                    {t('inbox.panel.interestPick')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {view.interests.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inbox.panel.noInterests')}</p>
      ) : (
        <ul className="space-y-3">
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
                        aria-label={t('inbox.remove')}
                        disabled={busy}
                        onClick={() => run((ack) => removeInterest(id, interest.id, ack))}
                      >
                        <Trash2 aria-hidden className="size-4" />
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
    </Block>
  );
}

/** A product photo through a short-lived signed address, as the catalog's own screens show it. */
function ProductThumb({ fileId, alt }: { readonly fileId: string | null; readonly alt: string }) {
  const url = useQuery({
    queryKey: ['files', 'url', fileId],
    queryFn: () => imageUrl(fileId ?? ''),
    enabled: fileId !== null,
    staleTime: 4 * 60_000,
  });
  return (
    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
      {url.data === undefined ? (
        <ImageOff aria-hidden className="size-4 text-muted-foreground" />
      ) : (
        <img src={url.data.url} alt={alt} className="size-full object-cover" />
      )}
    </div>
  );
}
