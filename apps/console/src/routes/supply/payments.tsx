import {
  Button,
  EmptyState,
  Money,
  PermissionGate,
  Section,
  Select,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  applyAdvance,
  listEntries,
  listPayments,
  listSuppliers,
  listWallets,
  paySupplier,
  type PaymentRow,
} from './api.js';
import { useSupplyT, type SupplyMessageKey } from './messages.js';
import {
  control,
  Field,
  LoadingRows,
  numericControl,
  SupplyHeader,
  TableFrame,
  TD,
  TD_NUMERIC,
  TH,
  TH_NUMERIC,
  TR,
} from './supply-nav.js';

/**
 * Supplier advances, payments, and setting an advance against a received entry (§7).
 *
 * Two things this screen has to be honest about, and both are in the copy rather than
 * only in the code:
 *
 * 1. **Above the org's threshold, nothing is posted.** §6 routes supplier payments above
 *    it through a checker, and the row comes back `pending_approval` with no journal — so
 *    the confirmation names the approval rather than saying "paid". A screen that said
 *    "paid" would be describing a different system, and the person would tell the
 *    supplier the money is on its way.
 * 2. **Applying an advance moves no cash.** It cancels two balances against each other,
 *    and the hint says so. Somebody who thought it was a second payment would pay twice.
 *
 * The wallet picker reads M08's own endpoint and sends back the wallet's
 * `ledgerAccountId`, which is what the payment endpoint wants (D-121): the ledger account
 * is what both modules already share, so neither reaches into the other's tables.
 */

const STATUS_TONE: Readonly<Record<PaymentRow['status'], 'warning' | 'success' | 'neutral'>> = {
  pending_approval: 'warning',
  posted: 'success',
  rejected: 'neutral',
};

export function SupplyPaymentsPage() {
  const ability = useAbility();
  const st = useSupplyT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Supply');
  const mayPay = ability.can('read', 'Cost');
  const today = new Date().toISOString().slice(0, 10);

  const [supplierId, setSupplierId] = useState('');
  const [walletAccountId, setWalletAccountId] = useState('');
  const [kind, setKind] = useState<'advance' | 'payment'>('payment');
  const [amountPoisha, setAmountPoisha] = useState('');
  const [memo, setMemo] = useState('');
  const [outcome, setOutcome] = useState<'posted' | 'pending_approval' | null>(null);

  const [advanceId, setAdvanceId] = useState('');
  const [supplyId, setSupplyId] = useState('');
  const [applyPoisha, setApplyPoisha] = useState('');

  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', 'picker'],
    queryFn: () => listSuppliers(),
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const wallets = useQuery({
    queryKey: ['supply', 'wallets', today],
    queryFn: () => listWallets(today),
    enabled: mayPay,
    staleTime: 5 * 60_000,
  });

  const payments = useQuery({
    queryKey: ['supply', 'payments'],
    queryFn: () => listPayments(),
    enabled: mayRead,
  });

  /** Received entries only: an advance cannot be set against a draft. */
  const entries = useQuery({
    queryKey: ['supply', 'entries', 'received'],
    queryFn: () => listEntries({ status: 'received' }),
    enabled: mayPay,
  });

  const pay = useMutation({
    mutationFn: () =>
      paySupplier({
        paymentId: crypto.randomUUID(),
        supplierId,
        walletAccountId,
        kind,
        amountPoisha,
        ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
      }),
    onSuccess: (result) => {
      setOutcome(result.status);
      setAmountPoisha('');
      setMemo('');
      void queryClient.invalidateQueries({ queryKey: ['supply'] });
    },
  });

  const apply = useMutation({
    mutationFn: () =>
      applyAdvance({
        applicationId: crypto.randomUUID(),
        paymentId: advanceId,
        supplyId,
        amountPoisha: applyPoisha,
      }),
    onSuccess: () => {
      setApplyPoisha('');
      void queryClient.invalidateQueries({ queryKey: ['supply'] });
    },
  });

  const openAdvances = (payments.data?.items ?? []).filter(
    (row) =>
      row.kind === 'advance' &&
      row.status === 'posted' &&
      BigInt(row.amountPoisha) > BigInt(row.appliedPoisha),
  );

  const rows = payments.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <SupplyHeader title={st('supply.payments')} description={st('supply.applyAdvanceHint')} />

        <PermissionGate allowed={mayPay}>
          <div className="grid gap-6 xl:grid-cols-5">
            <Section title={st('supply.pay')} className="xl:col-span-3">
              <form
                className="grid gap-4 sm:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setOutcome(null);
                  pay.mutate();
                }}
              >
                <Field label={st('supply.supplier')} id="payment-supplier">
                  <Select
                    id="payment-supplier"
                    value={supplierId}
                    required
                    placeholder={st('supply.supplier')}
                    options={(suppliers.data?.items ?? []).map((row) => ({
                      value: row.id,
                      label: `${row.code} · ${row.name}`,
                    }))}
                    onValueChange={setSupplierId}
                  />
                </Field>

                <Field label={st('supply.wallet')} id="payment-wallet">
                  <Select
                    id="payment-wallet"
                    value={walletAccountId}
                    required
                    placeholder={st('supply.wallet')}
                    options={(wallets.data?.items ?? [])
                      .filter((row) => row.isActive)
                      .map((row) => ({
                        value: row.ledgerAccountId,
                        label: `${row.code} · ${row.name}`,
                      }))}
                    onValueChange={setWalletAccountId}
                  />
                </Field>

                <Field label={st('supply.kind')} id="payment-kind">
                  <Select
                    id="payment-kind"
                    value={kind}
                    options={[
                      { value: 'payment', label: st('supply.kind.payment') },
                      { value: 'advance', label: st('supply.kind.advance') },
                    ]}
                    onValueChange={(value) => setKind(value === 'advance' ? 'advance' : 'payment')}
                  />
                </Field>

                <Field label={st('supply.amount')} id="payment-amount">
                  <input
                    id="payment-amount"
                    inputMode="numeric"
                    pattern="\d*"
                    value={amountPoisha}
                    required
                    className={numericControl}
                    onChange={(event) => setAmountPoisha(event.target.value)}
                  />
                </Field>

                <Field label={st('supply.memo')} id="payment-memo">
                  <input
                    id="payment-memo"
                    value={memo}
                    maxLength={500}
                    className={control}
                    onChange={(event) => setMemo(event.target.value)}
                  />
                </Field>

                <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 sm:col-span-2">
                  <Button
                    type="submit"
                    disabled={
                      supplierId === '' ||
                      walletAccountId === '' ||
                      !/^[1-9]\d*$/.test(amountPoisha) ||
                      pay.isPending
                    }
                  >
                    {st('supply.pay')}
                  </Button>
                  {amountPoisha !== '' && /^\d+$/.test(amountPoisha) ? (
                    <p className="text-sm font-medium">
                      <Money poisha={amountPoisha} />
                    </p>
                  ) : null}
                  {outcome !== null ? (
                    <p role="status" className="w-full text-sm text-muted-foreground">
                      {outcome === 'posted' ? st('supply.paymentPosted') : st('supply.paymentHeld')}
                    </p>
                  ) : null}
                  {pay.error !== null ? (
                    <p role="alert" className="w-full text-sm text-destructive">
                      {pay.error instanceof ApiError ? pay.error.message : st('supply.saveFailed')}
                    </p>
                  ) : null}
                </div>
              </form>
            </Section>

            <Section title={st('supply.applyAdvance')} className="xl:col-span-2">
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  apply.mutate();
                }}
              >
                <Field label={st('supply.kind.advance')} id="apply-advance">
                  <Select
                    id="apply-advance"
                    value={advanceId}
                    required
                    placeholder={st('supply.kind.advance')}
                    options={openAdvances.map((row) => ({
                      value: row.id,
                      label: `${row.supplierName} · ${row.businessDate}`,
                    }))}
                    onValueChange={setAdvanceId}
                  />
                </Field>

                <Field label={st('supply.entry')} id="apply-entry">
                  <Select
                    id="apply-entry"
                    value={supplyId}
                    required
                    placeholder={st('supply.entry')}
                    options={(entries.data?.items ?? []).map((row) => ({
                      value: row.id,
                      label: `${row.supplierName} · ${row.invoiceNumber ?? row.businessDate ?? row.id}`,
                    }))}
                    onValueChange={setSupplyId}
                  />
                </Field>

                <Field label={st('supply.amount')} id="apply-amount">
                  <input
                    id="apply-amount"
                    inputMode="numeric"
                    pattern="\d*"
                    value={applyPoisha}
                    required
                    className={numericControl}
                    onChange={(event) => setApplyPoisha(event.target.value)}
                  />
                </Field>

                <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={
                      advanceId === '' ||
                      supplyId === '' ||
                      !/^[1-9]\d*$/.test(applyPoisha) ||
                      apply.isPending
                    }
                  >
                    {st('supply.applyAdvance')}
                  </Button>
                  {apply.error !== null ? (
                    <p role="alert" className="w-full text-sm text-destructive">
                      {apply.error instanceof ApiError
                        ? apply.error.message
                        : st('supply.saveFailed')}
                    </p>
                  ) : null}
                </div>
              </form>
            </Section>
          </div>
        </PermissionGate>

        <section aria-label={st('supply.payments')}>
          {payments.isPending ? (
            <LoadingRows />
          ) : rows.length === 0 ? (
            <EmptyState icon={Banknote} title={st('supply.empty')} />
          ) : (
            <TableFrame label={st('supply.payments')}>
              <table className="w-full border-separate border-spacing-0 text-sm">
                <caption className="sr-only">{st('supply.payments')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      {st('supply.colDate')}
                    </th>
                    <th scope="col" className={TH}>
                      {st('supply.supplier')}
                    </th>
                    <th scope="col" className={TH}>
                      {st('supply.kind')}
                    </th>
                    <th scope="col" className={TH}>
                      {st('supply.wallet')}
                    </th>
                    <th scope="col" className={TH_NUMERIC}>
                      {st('supply.amount')}
                    </th>
                    <th scope="col" className={TH_NUMERIC}>
                      {st('supply.colApplied')}
                    </th>
                    <th scope="col" className={TH}>
                      {st('supply.colStatus')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className={TR}>
                      <td className={`${TD} text-muted-foreground tabular-nums`}>
                        {row.businessDate}
                      </td>
                      <td className={`${TD} font-medium`}>{row.supplierName}</td>
                      <td className={TD}>{st(`supply.kind.${row.kind}` as SupplyMessageKey)}</td>
                      <td className={`${TD} text-muted-foreground`}>{row.walletName}</td>
                      <td className={TD_NUMERIC}>
                        <Money poisha={row.amountPoisha} />
                      </td>
                      <td className={TD_NUMERIC}>
                        {row.kind === 'advance' ? <Money poisha={row.appliedPoisha} /> : '—'}
                      </td>
                      <td className={TD}>
                        <StatusBadge tone={STATUS_TONE[row.status]}>
                          {st(`supply.payStatus.${row.status}` as SupplyMessageKey)}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
        </section>
      </div>
    </PermissionGate>
  );
}
