import { Button, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { control, Field, numericControl, SupplyNav } from './supply-nav.js';

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

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{st('supply.payments')}</h1>
          <p className="text-sm text-muted-foreground">{st('supply.applyAdvanceHint')}</p>
        </header>

        <SupplyNav />

        <PermissionGate allowed={mayPay}>
          <form
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-5"
            onSubmit={(event) => {
              event.preventDefault();
              setOutcome(null);
              pay.mutate();
            }}
          >
            <Field label={st('supply.supplier')} id="payment-supplier">
              <select
                id="payment-supplier"
                value={supplierId}
                required
                className={control}
                onChange={(event) => setSupplierId(event.target.value)}
              >
                <option value="">{st('supply.supplier')}</option>
                {(suppliers.data?.items ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code} · {row.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={st('supply.wallet')} id="payment-wallet">
              <select
                id="payment-wallet"
                value={walletAccountId}
                required
                className={control}
                onChange={(event) => setWalletAccountId(event.target.value)}
              >
                <option value="">{st('supply.wallet')}</option>
                {(wallets.data?.items ?? [])
                  .filter((row) => row.isActive)
                  .map((row) => (
                    <option key={row.id} value={row.ledgerAccountId}>
                      {row.code} · {row.name}
                    </option>
                  ))}
              </select>
            </Field>

            <Field label={st('supply.kind')} id="payment-kind">
              <select
                id="payment-kind"
                value={kind}
                className={control}
                onChange={(event) =>
                  setKind(event.target.value === 'advance' ? 'advance' : 'payment')
                }
              >
                <option value="payment">{st('supply.kind.payment')}</option>
                <option value="advance">{st('supply.kind.advance')}</option>
              </select>
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

            <div className="flex flex-wrap items-center gap-3 sm:col-span-5">
              <Button
                type="submit"
                size="sm"
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
                <p className="text-sm text-muted-foreground">
                  <Money poisha={amountPoisha} />
                </p>
              ) : null}
              {outcome !== null ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {outcome === 'posted' ? st('supply.paymentPosted') : st('supply.paymentHeld')}
                </p>
              ) : null}
              {pay.error !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {pay.error instanceof ApiError ? pay.error.message : st('supply.saveFailed')}
                </p>
              ) : null}
            </div>
          </form>

          <form
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              apply.mutate();
            }}
          >
            <div className="sm:col-span-4">
              <h2 className="text-sm font-semibold">{st('supply.applyAdvance')}</h2>
              <p className="text-sm text-muted-foreground">{st('supply.applyAdvanceHint')}</p>
            </div>

            <Field label={st('supply.kind.advance')} id="apply-advance">
              <select
                id="apply-advance"
                value={advanceId}
                required
                className={control}
                onChange={(event) => setAdvanceId(event.target.value)}
              >
                <option value="">{st('supply.kind.advance')}</option>
                {openAdvances.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.supplierName} · {row.businessDate}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={st('supply.entry')} id="apply-entry">
              <select
                id="apply-entry"
                value={supplyId}
                required
                className={control}
                onChange={(event) => setSupplyId(event.target.value)}
              >
                <option value="">{st('supply.entry')}</option>
                {(entries.data?.items ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.supplierName} · {row.invoiceNumber ?? row.businessDate ?? row.id}
                  </option>
                ))}
              </select>
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

            <div className="flex items-end gap-3">
              <Button
                type="submit"
                size="sm"
                disabled={
                  advanceId === '' ||
                  supplyId === '' ||
                  !/^[1-9]\d*$/.test(applyPoisha) ||
                  apply.isPending
                }
              >
                {st('supply.applyAdvance')}
              </Button>
            </div>
            {apply.error !== null ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-4">
                {apply.error instanceof ApiError ? apply.error.message : st('supply.saveFailed')}
              </p>
            ) : null}
          </form>
        </PermissionGate>

        <section aria-label={st('supply.payments')} className="space-y-2">
          <table className="w-full text-sm">
            <caption className="sr-only">{st('supply.payments')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2">
                  {st('supply.colDate')}
                </th>
                <th scope="col" className="py-2">
                  {st('supply.supplier')}
                </th>
                <th scope="col" className="py-2">
                  {st('supply.kind')}
                </th>
                <th scope="col" className="py-2">
                  {st('supply.wallet')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {st('supply.amount')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {st('supply.colApplied')}
                </th>
                <th scope="col" className="py-2">
                  {st('supply.colStatus')}
                </th>
              </tr>
            </thead>
            <tbody>
              {(payments.data?.items ?? []).map((row) => (
                <tr key={row.id} className="border-b border-border/60">
                  <td className="py-2 tabular-nums">{row.businessDate}</td>
                  <td className="py-2">{row.supplierName}</td>
                  <td className="py-2">{st(`supply.kind.${row.kind}` as SupplyMessageKey)}</td>
                  <td className="py-2">{row.walletName}</td>
                  <td className="py-2 text-right">
                    <Money poisha={row.amountPoisha} />
                  </td>
                  <td className="py-2 text-right">
                    {row.kind === 'advance' ? <Money poisha={row.appliedPoisha} /> : '—'}
                  </td>
                  <td className="py-2">
                    <StatusBadge tone={STATUS_TONE[row.status]}>
                      {st(`supply.payStatus.${row.status}` as SupplyMessageKey)}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(payments.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
          ) : null}
        </section>
      </div>
    </PermissionGate>
  );
}
