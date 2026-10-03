import { Button, Input, Label, Money, PermissionGate, Select, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { AccountsHeader, Block, LoadingRows } from './accounts-parts.js';
import { dhakaToday, ledgerAccounts, listWallets, transfer, type TransferResult } from './api.js';
import { useAccountsT, type AccountsMessageKey } from './messages.js';
import { checkTransfer } from './transfer-form.js';

/**
 * Moving money between two of the brand's wallets (M08, §7).
 *
 * Hand cash to the bank, bKash to hand cash, one branch's till to the office. The
 * journal is Dr the receiving wallet / Cr the sending one, and a bank charge is a
 * third line (Dr Bank charges), never netted off the amount: a transfer that
 * silently absorbed the charge would leave the two wallets disagreeing with the
 * statements by exactly that charge.
 *
 * The id is made once per attempt and replaced whenever a field changes, so a
 * request retried after a dropped connection is the same transfer, and an edited
 * one is a new transfer rather than a replay of the old.
 */
export function TransfersPage() {
  const a = useAccountsT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const formId = useId();

  const mayWrite = ability.can('update', 'Wallet');
  const wallets = useQuery({
    queryKey: ['accounts', 'wallets', dhakaToday()],
    queryFn: () => listWallets(),
    enabled: mayWrite,
  });
  // The charge account is only visible to a role that reads the chart of accounts.
  const accounts = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: ledgerAccounts,
    enabled: mayWrite && ability.can('read', 'LedgerReport'),
  });
  const chargeAccount = accounts.data?.items.find(
    (account) => account.subtype === 'bank_charges' && account.isActive,
  );

  const [fromWalletId, setFrom] = useState('');
  const [toWalletId, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [charge, setCharge] = useState('');
  const [memo, setMemo] = useState('');
  // One of this screen's sentences, or the server's own message, never a guess between them.
  const [problem, setProblem] = useState<{ key: AccountsMessageKey } | { text: string } | null>(
    null,
  );
  const [result, setResult] = useState<TransferResult | null>(null);
  const [transferId, setTransferId] = useState(() => crypto.randomUUID());

  const edited = <T,>(set: (value: T) => void) => {
    return (value: T) => {
      set(value);
      setTransferId(crypto.randomUUID());
      setProblem(null);
    };
  };

  const send = useMutation({
    mutationFn: transfer,
    onSuccess: async (done) => {
      setResult(done);
      setProblem(null);
      setAmount('');
      setCharge('');
      setMemo('');
      setTransferId(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['ledger'] });
    },
    onError: (error: unknown) => {
      setResult(null);
      setProblem(
        error instanceof ApiError ? { text: error.message } : { key: 'accounts.transfer.failed' },
      );
    },
  });

  const active = (wallets.data?.items ?? []).filter((wallet) => wallet.isActive);
  const nameOf = (id: string) => active.find((wallet) => wallet.id === id)?.name ?? '';

  const submit = () => {
    const checked = checkTransfer({ fromWalletId, toWalletId, amount, charge });
    if (!checked.ok) {
      setProblem({ key: checked.problem });
      return;
    }
    const { amountPoisha, chargePoisha } = checked;
    send.mutate({
      transferId,
      fromWalletId,
      toWalletId,
      amountPoisha,
      chargePoisha,
      ...(chargePoisha !== '0' && chargeAccount !== undefined
        ? { chargeAccountId: chargeAccount.id }
        : {}),
      ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
    });
  };

  const message = (value: { key: AccountsMessageKey } | { text: string }) =>
    'key' in value ? a(value.key) : value.text;

  return (
    <div className="space-y-6">
      <AccountsHeader
        title={a('accounts.transfer.title')}
        subtitle={a('accounts.transfer.subtitle')}
      />

      <PermissionGate
        allowed={mayWrite}
        explain={{ title: a('accounts.deniedTitle'), detail: a('accounts.deniedDetail') }}
      >
        <Block title={a('accounts.transfer.formHeading')} caption={a('accounts.transfer.caption')}>
          {wallets.isPending ? (
            <LoadingRows />
          ) : (
            <form
              className="space-y-4 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-end">
                <WalletSelect
                  id={`${formId}-from`}
                  label={a('accounts.transfer.from')}
                  value={fromWalletId}
                  wallets={active}
                  onChange={edited(setFrom)}
                  placeholder={a('accounts.pickWallet')}
                />
                <ArrowRight
                  className="mx-auto hidden size-4 text-muted-foreground md:mb-3 md:block"
                  aria-hidden="true"
                />
                <WalletSelect
                  id={`${formId}-to`}
                  label={a('accounts.transfer.to')}
                  value={toWalletId}
                  wallets={active}
                  onChange={edited(setTo)}
                  placeholder={a('accounts.pickWallet')}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`${formId}-amount`} required>
                    {a('accounts.fieldAmount')}
                  </Label>
                  <Input
                    id={`${formId}-amount`}
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={amount}
                    onChange={(event) => edited(setAmount)(event.target.value)}
                  />
                </div>
                {chargeAccount === undefined ? null : (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${formId}-charge`}>{a('accounts.transfer.charge')}</Label>
                    <Input
                      id={`${formId}-charge`}
                      inputMode="decimal"
                      className="text-right tabular-nums"
                      value={charge}
                      aria-describedby={`${formId}-charge-hint`}
                      onChange={(event) => edited(setCharge)(event.target.value)}
                    />
                    <p id={`${formId}-charge-hint`} className="text-xs text-muted-foreground">
                      {a('accounts.transfer.chargeHint')}
                    </p>
                  </div>
                )}
                <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
                  <Label htmlFor={`${formId}-memo`}>{a('accounts.fieldMemo')}</Label>
                  <Input
                    id={`${formId}-memo`}
                    value={memo}
                    maxLength={500}
                    onChange={(event) => edited(setMemo)(event.target.value)}
                  />
                </div>
              </div>

              {problem === null ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {message(problem)}
                </p>
              )}

              <Button type="submit" disabled={send.isPending}>
                {send.isPending ? a('accounts.saving') : a('accounts.transfer.submit')}
              </Button>
            </form>
          )}
        </Block>

        {result === null ? null : (
          <Block
            title={a('accounts.transfer.doneHeading')}
            action={
              <StatusBadge tone={result.created ? 'success' : 'neutral'}>
                {a(result.created ? 'accounts.transfer.posted' : 'accounts.transfer.replayed')}
              </StatusBadge>
            }
          >
            <dl className="grid gap-px bg-border sm:grid-cols-3" role="status">
              <div className="bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">{a('accounts.fieldAmount')}</dt>
                <dd className="mt-1 text-base font-semibold">
                  <Money poisha={result.amountPoisha} locale={locale} />
                </dd>
              </div>
              <div className="bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">{a('accounts.transfer.charge')}</dt>
                <dd className="mt-1 text-base font-semibold">
                  <Money poisha={result.chargePoisha} locale={locale} />
                </dd>
              </div>
              <div className="bg-card px-4 py-3">
                <dt className="text-xs text-muted-foreground">{a('accounts.fieldBusinessDate')}</dt>
                <dd className="mt-1 text-base font-semibold tabular-nums">{result.businessDate}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3 text-sm">
              {[fromWalletId, toWalletId].map((walletId) => {
                const wallet = active.find((row) => row.id === walletId);
                return wallet === undefined ? null : (
                  <Link
                    key={walletId}
                    to="/accounts/wallets/$accountId"
                    params={{ accountId: wallet.ledgerAccountId }}
                    className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {`${a('accounts.book.open')}: ${nameOf(walletId)}`}
                  </Link>
                );
              })}
            </div>
          </Block>
        )}
      </PermissionGate>
    </div>
  );
}

function WalletSelect({
  id,
  label,
  value,
  wallets,
  placeholder,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly wallets: readonly { id: string; code: string; name: string }[];
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} required>
        {label}
      </Label>
      <Select
        id={id}
        value={value}
        placeholder={placeholder}
        onValueChange={onChange}
        options={wallets.map((wallet) => ({
          value: wallet.id,
          label: `${wallet.code} · ${wallet.name}`,
        }))}
      />
    </div>
  );
}
