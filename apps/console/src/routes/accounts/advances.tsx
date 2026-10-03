import {
  Button,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Select,
  Skeleton,
  StatusBadge,
  cn,
  controlClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  advanceQueue,
  refundAdvance,
  rejectAdvance,
  verifyAdvance,
  type QueueRow,
} from '../orders/advances-api.js';
import { ADVANCE_TONE } from '../orders/advances-panel.js';
import { useOrdersT, type OrdersMessageKey } from '../orders/messages.js';
import { ordersPath } from '../orders/paths.js';
import { AccountsHeader } from './accounts-parts.js';
import { dhakaToday, listWallets } from './api.js';
import { useAccountsT } from './messages.js';

/**
 * The accounts queue for advances (M17, D-013, D-230, D-232).
 *
 * Two lists of work, and nothing else: claims to check against a wallet, and refunds owed
 * after an order ended. Verifying books the money (Dr Wallet / Cr Customer advance) and
 * lowers what the rider collects; rejecting books nothing; recording a refund books the money
 * going back. The server refuses a verification by the person who recorded the claim, and
 * the screen says why in the server's own words.
 */

type Tab = 'pending' | 'refund_due';
interface Acting {
  readonly kind: 'verify' | 'reject' | 'refund';
  readonly row: QueueRow;
}

const control = `${controlClassName} w-full disabled:opacity-50`;
/** The two queues as a segmented control: one view of the page, not a route each. */
const TAB =
  'h-7 rounded-md px-3 text-sm text-muted-foreground motion-safe:transition-colors motion-safe:duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AdvancesPage() {
  const a = useAccountsT();
  const t = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const allowed = ability.can('create', 'Wallet');
  const [tab, setTab] = useState<Tab>('pending');
  const [acting, setActing] = useState<Acting | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['accounts', 'advances', tab],
    queryFn: () => advanceQueue([tab]),
    enabled: allowed,
  });
  const items = queue.data?.items ?? [];

  return (
    <PermissionGate
      allowed={allowed}
      explain={{ title: a('accounts.deniedTitle'), detail: a('accounts.deniedDetail') }}
    >
      <div className="space-y-5">
        <AccountsHeader
          title={a('accounts.advances.title')}
          subtitle={a('accounts.advances.subtitle')}
        />

        <div
          role="tablist"
          aria-label={a('accounts.advances.title')}
          className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5"
        >
          {(['pending', 'refund_due'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={cn(TAB, tab === value && 'bg-background font-medium text-foreground')}
              onClick={() => setTab(value)}
            >
              {a(value === 'pending' ? 'accounts.advances.toVerify' : 'accounts.advances.toRefund')}
            </button>
          ))}
        </div>

        {notice === null ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}

        {queue.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : queue.isError ? (
          <ErrorState
            title={a('accounts.walletsErrorTitle')}
            detail={queue.error instanceof Error ? queue.error.message : ''}
            action={
              <Button size="sm" variant="outline" onClick={() => void queue.refetch()}>
                {a('accounts.report.retry')}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={a('accounts.advances.emptyTitle')}
            detail={a('accounts.advances.emptyDetail')}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{a('accounts.advances.title')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2">
                    {a('accounts.advances.colOrder')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {a('accounts.advances.colMethod')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {a('accounts.advances.colReference')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {tab === 'pending'
                      ? a('accounts.advances.colAmount')
                      : a('accounts.advances.owed')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {a('accounts.advances.colRecorded')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {a('accounts.advances.colStatus')}
                  </th>
                  <th scope="col" className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="h-row border-b border-border last:border-0">
                    <td className="px-3 font-medium tabular-nums">
                      <Link
                        to={ordersPath(`/orders/${row.orderId}`)}
                        className="underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {row.orderNo}
                      </Link>
                    </td>
                    <td className="px-3">
                      {t(`orders.advances.method.${row.method}` as OrdersMessageKey)}
                    </td>
                    <td className="px-3 tabular-nums">{row.transactionRef}</td>
                    <td className="px-3 text-right">
                      <Money
                        poisha={tab === 'pending' ? row.amountPoisha : row.owedPoisha}
                        locale={locale}
                      />
                    </td>
                    <td className="px-3 text-xs text-muted-foreground">
                      <DateTime value={row.recordedAt} />
                    </td>
                    <td className="px-3">
                      <StatusBadge tone={ADVANCE_TONE[row.status]}>
                        {t(`orders.advances.status.${row.status}` as OrdersMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className="px-3 text-right whitespace-nowrap">
                      {row.status === 'pending' ? (
                        <span className="inline-flex gap-1.5">
                          <Button size="sm" onClick={() => setActing({ kind: 'verify', row })}>
                            {a('accounts.advances.verify')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setActing({ kind: 'reject', row })}
                          >
                            {a('accounts.advances.reject')}
                          </Button>
                        </span>
                      ) : row.status === 'refund_due' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setActing({ kind: 'refund', row })}
                        >
                          {a('accounts.advances.refund')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {acting === null ? null : (
          <ActDialog
            acting={acting}
            onClose={() => setActing(null)}
            onDone={() => {
              setActing(null);
              setNotice(a('accounts.advances.done'));
            }}
          />
        )}
      </div>
    </PermissionGate>
  );
}

function ActDialog({
  acting,
  onClose,
  onDone,
}: {
  readonly acting: Acting;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const a = useAccountsT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const id = useId();
  const { kind, row } = acting;
  const [walletAccountId, setWallet] = useState(
    kind === 'refund' ? (row.walletAccountId ?? '') : '',
  );
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const wallets = useQuery({
    queryKey: ['accounts', 'wallets', dhakaToday()],
    queryFn: () => listWallets(),
    enabled: kind !== 'reject',
  });
  const active = (wallets.data?.items ?? []).filter((wallet) => wallet.isActive);

  const act = useMutation({
    mutationFn: () => {
      if (kind === 'verify') return verifyAdvance(row.id, walletAccountId);
      if (kind === 'reject') return rejectAdvance(row.id, text.trim());
      return refundAdvance(row.id, {
        ...(walletAccountId === '' ? {} : { walletAccountId }),
        ...(text.trim() === '' ? {} : { refundRef: text.trim() }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      onDone();
    },
    onError: (error) =>
      setProblem(
        `${a('accounts.advances.failed')} ${error instanceof ApiError ? error.message : String(error)}`,
      ),
  });

  const ready =
    kind === 'verify' ? walletAccountId !== '' : kind === 'reject' ? text.trim().length >= 3 : true;
  const title =
    kind === 'verify'
      ? a('accounts.advances.verifyTitle')
      : kind === 'reject'
        ? a('accounts.advances.rejectTitle')
        : a('accounts.advances.refundTitle');

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`${title} · ${row.orderNo}`}
      {...(kind === 'verify'
        ? { description: a('accounts.advances.verifyDetail') }
        : kind === 'refund'
          ? { description: a('accounts.advances.refundDetail') }
          : {})}
      closeLabel={a('accounts.advances.cancel')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {a('accounts.advances.cancel')}
          </Button>
          <Button
            variant={kind === 'reject' ? 'destructive' : 'primary'}
            disabled={!ready || act.isPending}
            onClick={() => {
              setProblem(null);
              act.mutate();
            }}
          >
            {kind === 'verify'
              ? a('accounts.advances.verify')
              : kind === 'reject'
                ? a('accounts.advances.reject')
                : a('accounts.advances.refund')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="flex items-center justify-between gap-2">
          <span className="tabular-nums">{row.transactionRef}</span>
          <Money poisha={kind === 'refund' ? row.owedPoisha : row.amountPoisha} locale={locale} />
        </p>
        {kind === 'reject' ? null : (
          <div className="space-y-1.5">
            <label className="block font-medium" htmlFor={`${id}-wallet`}>
              {kind === 'verify'
                ? a('accounts.advances.wallet')
                : a('accounts.advances.refundWallet')}
            </label>
            <Select
              id={`${id}-wallet`}
              value={walletAccountId}
              placeholder={a('accounts.advances.pickWallet')}
              onValueChange={setWallet}
              options={[
                // A refund may leave the wallet to the one the advance arrived in; a
                // verification must name one, so it offers no empty choice.
                ...(kind === 'refund'
                  ? [{ value: '', label: a('accounts.advances.pickWallet') }]
                  : []),
                ...active.map((wallet) => ({
                  value: wallet.ledgerAccountId,
                  label: `${wallet.code} · ${wallet.name}`,
                })),
              ]}
            />
          </div>
        )}
        {kind === 'verify' ? null : (
          <label className="block space-y-1.5" htmlFor={`${id}-text`}>
            <span className="font-medium">
              {kind === 'reject'
                ? a('accounts.advances.rejectReason')
                : a('accounts.advances.refundRef')}
            </span>
            <input
              id={`${id}-text`}
              value={text}
              maxLength={kind === 'reject' ? 500 : 40}
              className={control}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        )}
        {problem === null ? null : (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}
