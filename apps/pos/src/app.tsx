import { Button, ErrorState, Skeleton, StatusBadge, cn } from '@elysium/ui';
import { CloudOff, LogOut, Moon, RefreshCw, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { LocaleProvider, useLocale, usePosT } from './i18n/locale.js';
import type { PosMessageKey } from './i18n/messages.js';
import { ApiError, endpoints, NetworkError, type RegisterView, type Session } from './lib/api.js';
import { cartReducer, EMPTY_CART, type PriceListItem } from './lib/cart.js';
import { getValue, outbox, setValue, type OutboxEntry } from './lib/store.js';
import { SyncEngine, type SyncState } from './lib/sync.js';
import { PrintArea, printReceipt, type ReceiptData } from './receipt/receipt.js';
import { CloseShift, Queue } from './screens/queue.js';
import { Returns } from './screens/returns.js';
import { Sell } from './screens/sell.js';
import { OpenShift, PickOrg, PickRegister, SignIn } from './screens/setup.js';
import { applyTheme, isDark } from './theme.js';

/**
 * The till (architecture §14, §24 "PWAs").
 *
 * **Offline first, not offline tolerant.** Everything a sale needs — the
 * register, the open shift, the cashier's discount ceiling, the receipt header and
 * the price list — is cached in IndexedDB the last time the till was online. On
 * start the till reads that cache *before* it asks the server anything, so a till
 * reloaded with no connection goes straight back to selling on the shift it had
 * open. The server is asked in the background and only ever improves on the cache.
 *
 * Three things do need the server, because each is a fact about more than this
 * till: signing in, opening or closing a shift, and looking a receipt up for a
 * return. They say so on screen rather than failing.
 */

type Phase =
  | { readonly kind: 'boot' }
  | { readonly kind: 'signIn' }
  | { readonly kind: 'pickOrg' }
  | { readonly kind: 'pickRegister' }
  | { readonly kind: 'till' }
  | { readonly kind: 'failed' };

type Tab = 'sell' | 'returns' | 'queue' | 'close';

const SESSION_KEY = 'session';
const REGISTER_KEY = 'register-id';
const priceListKey = (registerId: string) => `price-list:${registerId}`;

export function App() {
  return (
    <LocaleProvider>
      <Till />
    </LocaleProvider>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

function Till() {
  const t = usePosT();
  const online = useOnline();
  const engine = useMemo(() => new SyncEngine(), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' });
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<readonly PriceListItem[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [entries, setEntries] = useState<readonly OutboxEntry[]>([]);
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' });
  const [tab, setTab] = useState<Tab>('sell');
  const [cart, dispatch] = useReducer(cartReducer, EMPTY_CART);
  const [printable, setPrintable] = useState<ReceiptData | null>(null);
  const printNext = useRef(false);

  const refreshEntries = useCallback(() => {
    void outbox().then(setEntries);
  }, []);

  /** Ask the server for the session and price list; fall back to the cache. */
  const load = useCallback(async (registerId: string) => {
    try {
      const fresh = await endpoints.session(registerId);
      await setValue(SESSION_KEY, fresh);
      setSession(fresh);
      setPhase({ kind: 'till' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setPhase({ kind: 'signIn' });
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        setPhase({ kind: 'pickRegister' });
        return;
      }
      // Unreachable: keep whatever the cache already put on screen.
      const cached = await getValue<Session | null>(SESSION_KEY);
      if (cached == null) setPhase({ kind: error instanceof NetworkError ? 'signIn' : 'failed' });
      return;
    }
    try {
      const all: PriceListItem[] = [];
      let after: string | null = null;
      do {
        const page = await endpoints.priceList(registerId, after);
        all.push(...page.items);
        after = page.next;
      } while (after !== null);
      await setValue(priceListKey(registerId), all);
      setItems(all);
      setListState('ready');
    } catch {
      setListState((current) => (current === 'ready' ? 'ready' : 'failed'));
    }
  }, []);

  // Boot: the cache first, then the server.
  useEffect(() => {
    void (async () => {
      const registerId = await getValue<string>(REGISTER_KEY);
      const cached = await getValue<Session | null>(SESSION_KEY);
      if (registerId !== undefined && cached?.register.id === registerId) {
        setSession(cached);
        const list = await getValue<PriceListItem[]>(priceListKey(registerId));
        if (list !== undefined) {
          setItems(list);
          setListState('ready');
        }
        setPhase({ kind: 'till' });
      }
      refreshEntries();
      if (registerId !== undefined) await load(registerId);
      else if (navigator.onLine) {
        try {
          const me = await endpoints.me();
          setPhase({ kind: me.orgId === null ? 'pickOrg' : 'pickRegister' });
        } catch {
          setPhase({ kind: 'signIn' });
        }
      } else setPhase({ kind: 'signIn' });
    })();
  }, [load, refreshEntries]);

  // The sync engine runs for the life of the page and repaints the queue.
  useEffect(() => {
    const stop = engine.start();
    const unsubscribe = engine.subscribe((state) => {
      setSync(state);
      refreshEntries();
    });
    return () => {
      stop();
      unsubscribe();
    };
  }, [engine, refreshEntries]);

  // Print once the receipt has reached the print region.
  useEffect(() => {
    if (printable !== null && printNext.current) {
      printNext.current = false;
      printReceipt();
    }
  }, [printable]);

  const waiting = entries.filter((entry) => entry.status === 'queued').length;
  const failed = entries.filter((entry) => entry.status === 'failed').length;

  async function pickRegister(register: RegisterView) {
    await setValue(REGISTER_KEY, register.id);
    setPhase({ kind: 'boot' });
    await load(register.id);
  }

  function recorded(receipt: ReceiptData) {
    setPrintable(receipt);
    refreshEntries();
    void engine.flush();
  }

  const openShift = session?.openShift ?? null;
  const body = (() => {
    switch (phase.kind) {
      case 'boot':
        return (
          <div className="mx-auto max-w-md space-y-3 p-10">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-2/3" />
          </div>
        );
      case 'failed':
        return (
          <div className="mx-auto max-w-md p-10">
            <ErrorState title={t('pos.error.generic')} />
          </div>
        );
      case 'signIn':
        return (
          <SignIn
            onSignedIn={() => {
              setPhase({ kind: 'pickOrg' });
            }}
          />
        );
      case 'pickOrg':
        return (
          <PickOrg
            onPicked={() => {
              void getValue<string>(REGISTER_KEY).then((registerId) => {
                if (registerId === undefined) setPhase({ kind: 'pickRegister' });
                else void load(registerId).then(() => engine.flush());
              });
            }}
          />
        );
      case 'pickRegister':
        return <PickRegister onPicked={(register) => void pickRegister(register)} />;
      case 'till': {
        if (session === null) return null;
        if (openShift === null) {
          return (
            <OpenShift
              registerId={session.register.id}
              online={online}
              onOpened={() => {
                void load(session.register.id);
              }}
            />
          );
        }
        if (!openShift.mine) {
          return (
            <div className="mx-auto max-w-md p-10">
              <ErrorState title={t('pos.shift.someoneElse')} />
            </div>
          );
        }
        const active = { ...session, openShift };
        if (tab === 'returns') {
          return (
            <Returns
              session={active}
              online={online}
              onRecorded={recorded}
              onExchange={(returnId) => {
                dispatch({ type: 'exchange', returnId });
                setTab('sell');
              }}
            />
          );
        }
        if (tab === 'queue') {
          return (
            <Queue
              entries={entries}
              onRetry={() => {
                refreshEntries();
                void engine.flush();
              }}
              onReprint={(receipt) => {
                printNext.current = true;
                // A new object each time, so reprinting the same receipt twice prints twice.
                setPrintable({ ...receipt });
              }}
            />
          );
        }
        if (tab === 'close') {
          return (
            <CloseShift
              shiftId={openShift.id}
              online={online}
              waiting={waiting}
              failed={failed}
              onClosed={() => {
                setTab('sell');
                void load(session.register.id);
              }}
            />
          );
        }
        return (
          <Sell
            session={active}
            priceList={{ items, state: listState }}
            cart={cart}
            dispatch={dispatch}
            online={online}
            onRecorded={recorded}
          />
        );
      }
    }
  })();

  return (
    <>
      <div className="flex min-h-dvh flex-col bg-canvas text-foreground print:hidden">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
        >
          {t('pos.app.skipToContent')}
        </a>
        <TopBar
          session={phase.kind === 'till' ? session : null}
          online={online}
          sync={sync}
          waiting={waiting}
          failed={failed}
          tab={tab}
          onTab={setTab}
          onSync={() => void engine.flush()}
          onSignOut={() => {
            void endpoints
              .signOut()
              .catch(() => undefined)
              // The cached session says whose shift is open; left behind, the next
              // cashier's till would start offline as the last one.
              .then(() => setValue(SESSION_KEY, null))
              .then(() => {
                setSession(null);
                setPhase({ kind: 'signIn' });
              });
          }}
        />
        {body}
      </div>
      <PrintArea data={printable} />
    </>
  );
}

const TABS: readonly { readonly tab: Tab; readonly label: PosMessageKey }[] = [
  { tab: 'sell', label: 'pos.sell.menuSell' },
  { tab: 'returns', label: 'pos.sell.menuReturns' },
  { tab: 'queue', label: 'pos.sell.menuQueue' },
  { tab: 'close', label: 'pos.sell.menuCloseShift' },
];

function TopBar({
  session,
  online,
  sync,
  waiting,
  failed,
  tab,
  onTab,
  onSync,
  onSignOut,
}: {
  readonly session: Session | null;
  readonly online: boolean;
  readonly sync: SyncState;
  readonly waiting: number;
  readonly failed: number;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly onSync: () => void;
  readonly onSignOut: () => void;
}) {
  const t = usePosT();
  const { locale, setLocale } = useLocale();
  const [dark, setDark] = useState(isDark);
  const selling = session?.openShift?.mine === true;
  const brandName = session?.receiptHeader.displayName ?? '';

  // The tab carries the brand's own name, from its row (D-472); the shipped page names none.
  useEffect(() => {
    document.title = brandName === '' ? t('pos.app.name') : `${brandName} · ${t('pos.app.name')}`;
  }, [brandName, t]);

  const status = !online
    ? { tone: 'warning' as const, label: t('pos.status.offline') }
    : sync.kind === 'syncing'
      ? { tone: 'info' as const, label: t('pos.status.syncing') }
      : sync.kind === 'signedOut'
        ? { tone: 'danger' as const, label: t('pos.status.signedOut') }
        : sync.kind === 'error'
          ? { tone: 'danger' as const, label: t('pos.status.syncError') }
          : { tone: 'success' as const, label: t('pos.status.online') };

  return (
    <header className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-canvas px-4 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold tracking-tight">{t('pos.app.name')}</span>
        {session === null ? null : (
          <span className="truncate text-xs text-muted-foreground">
            {session.register.branchName} · {session.register.code}
            {session.openShift === null
              ? ''
              : ` · ${t('pos.shift.label')} ${String(session.openShift.shiftNo)}`}
          </span>
        )}
      </div>

      {/* The till's four screens as one segmented control: 44px targets, the one you are
          on lifted onto the page surface (D-460). */}
      {selling ? (
        <nav className="flex gap-1 rounded-lg bg-muted p-1" aria-label={t('pos.app.name')}>
          {TABS.map((entry) => (
            <button
              key={entry.tab}
              type="button"
              aria-current={tab === entry.tab ? 'page' : undefined}
              onClick={() => {
                onTab(entry.tab);
              }}
              className={cn(
                'h-11 rounded-md px-4 text-sm font-medium transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                tab === entry.tab
                  ? 'bg-background text-foreground ring-1 ring-border'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(entry.label)}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        <span role="status" data-testid="connection" data-online={online}>
          <StatusBadge tone={status.tone}>
            {online ? null : <CloudOff aria-hidden />}
            {status.label}
          </StatusBadge>
        </span>
        {waiting > 0 ? (
          <span data-testid="waiting" data-count={waiting}>
            <StatusBadge tone="warning">
              <span className="tabular-nums">{waiting}</span> {t('pos.status.waiting')}
            </StatusBadge>
          </span>
        ) : null}
        {failed > 0 ? (
          <span data-testid="failed" data-count={failed}>
            <StatusBadge tone="danger">
              <span className="tabular-nums">{failed}</span> {t('pos.status.failed')}
            </StatusBadge>
          </span>
        ) : null}
        <Button
          size="lg"
          variant="outline"
          className="min-h-11"
          onClick={onSync}
          disabled={!online}
        >
          <RefreshCw aria-hidden />
          {t('pos.action.syncNow')}
        </Button>
        <Button
          size="lg"
          variant="ghost"
          className="min-h-11 text-muted-foreground hover:text-foreground"
          aria-label={t('pos.locale.label')}
          onClick={() => {
            setLocale(locale === 'en' ? 'bn' : 'en');
          }}
        >
          {locale === 'en' ? t('pos.locale.toBangla') : t('pos.locale.toEnglish')}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="min-h-11 min-w-11"
          aria-label={dark ? t('pos.theme.toLight') : t('pos.theme.toDark')}
          onClick={() => {
            applyTheme(dark ? 'light' : 'dark');
            setDark(!dark);
          }}
        >
          {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </Button>
        {session === null ? null : (
          <Button
            size="lg"
            variant="ghost"
            className="min-h-11"
            onClick={onSignOut}
            // Unsynced sales belong to this cashier's shift; the next person's session
            // could not send them. They must reach the server before the till changes hands.
            disabled={waiting > 0 || !online}
          >
            <LogOut aria-hidden />
            {t('pos.action.signOut')}
          </Button>
        )}
      </div>
    </header>
  );
}
