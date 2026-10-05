import { zodResolver } from '@hookform/resolvers/zod';
import {
  Button,
  Dialog,
  Form,
  PermissionGate,
  SelectField,
  StatusBadge,
  TextField,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useForm, useWatch, type UseFormRegisterReturn } from 'react-hook-form';
import { z } from 'zod';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { listBranches } from '../branches/api.js';
import { AccountsHeader, Block, Empty, LoadFailed, LoadingRows } from './accounts-parts.js';
import {
  createWallet,
  dhakaToday,
  listWallets,
  updateWallet,
  type WalletRow,
  type WalletSubtype,
} from './api.js';
import { useAccountsT, type AccountsMessageKey } from './messages.js';
import { HeadsSection } from './heads.js';

/**
 * Setting up the brand's wallets (M08, §7): the tills, bank accounts and mobile
 * wallets money is kept in.
 *
 * A wallet is a ledger account with a little more said about it, so adding one
 * adds the account too, and the code, name and kind are fixed once it exists —
 * posted journals name that account, and renaming it would rewrite what every
 * past statement says. What stays editable is what describes it: the provider,
 * whether it is counted at every day's close, and whether it is still in use.
 * Closing a wallet keeps its history; it just takes no new entries.
 *
 * The account number is never asked for. The last two to four digits identify
 * it on a statement, and a field that takes the whole number will be given it
 * (invariant 10).
 */

const SUBTYPES = ['wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other'] as const;

const SUBTYPE_LABELS: Record<WalletSubtype, AccountsMessageKey> = {
  wallet_cash: 'accounts.kindHandCash',
  wallet_bank: 'accounts.kindBank',
  wallet_bkash: 'accounts.kindBkash',
  wallet_mfs_other: 'accounts.kindMfsOther',
};

interface Messages {
  readonly code: string;
  readonly last4: string;
  readonly branch: string;
}

/**
 * The add-wallet form, built with its translated messages (the kit's
 * `FormField` shows a schema's message as written). The server checks every one
 * of these again; this saves the round trip.
 */
function createSchema(messages: Messages) {
  return z
    .object({
      subtype: z.enum(SUBTYPES),
      code: z
        .string()
        .trim()
        .regex(/^[0-9A-Z][0-9A-Z-]{0,31}$/, messages.code),
      name: z.string().trim().min(1).max(120),
      branchId: z.string().optional(),
      provider: z.string().trim().max(80).optional(),
      accountRefLast4: z
        .string()
        .trim()
        .regex(/^(\d{2,4})?$/, messages.last4)
        .optional(),
      requiresDailyClosing: z.boolean(),
    })
    .superRefine((value, context) => {
      if (value.subtype === 'wallet_cash' && (value.branchId ?? '') === '') {
        context.addIssue({ code: 'custom', path: ['branchId'], message: messages.branch });
      }
    });
}
type CreateForm = z.infer<ReturnType<typeof createSchema>>;

const editSchema = z.object({
  provider: z.string().trim().max(80).optional(),
  requiresDailyClosing: z.boolean(),
  isActive: z.boolean(),
});
type EditForm = z.infer<typeof editSchema>;

const CREATE_DEFAULTS: CreateForm = {
  subtype: 'wallet_bank',
  code: '',
  name: '',
  branchId: '',
  provider: '',
  accountRefLast4: '',
  requiresDailyClosing: true,
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** `''` and whitespace are "not given", which the server wants left out. */
function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

export function WalletsSetupPage() {
  const a = useAccountsT();
  const t = useT();
  const ability = useAbility();
  const queryClient = useQueryClient();

  const mayCreate = ability.can('create', 'Wallet');
  const mayUpdate = ability.can('update', 'Wallet');

  const wallets = useQuery({
    queryKey: ['accounts', 'wallets', dhakaToday(), 'all'],
    queryFn: () => listWallets(undefined, { includeInactive: true }),
    enabled: mayCreate || mayUpdate,
  });
  // Every role that may add a wallet reads the ledger reports, which is what the
  // branch list sits behind; without it the picker is simply empty.
  const branches = useQuery({
    queryKey: ['pos', 'branches'],
    queryFn: listBranches,
    enabled: mayCreate && ability.can('read', 'LedgerReport'),
  });
  const branchName = useMemo(
    () => new Map((branches.data?.items ?? []).map((branch) => [branch.id, branch.name])),
    [branches.data],
  );

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WalletRow | null>(null);
  const [notice, setNotice] = useState<AccountsMessageKey | null>(null);

  const codeInvalid = a('accounts.setup.codeInvalid');
  const last4Invalid = a('accounts.setup.last4Invalid');
  const branchRequired = a('accounts.setup.branchRequired');
  const schema = useMemo(
    () => createSchema({ code: codeInvalid, last4: last4Invalid, branch: branchRequired }),
    [codeInvalid, last4Invalid, branchRequired],
  );

  const createForm = useForm<CreateForm>({
    resolver: zodResolver(schema),
    defaultValues: CREATE_DEFAULTS,
  });
  const subtype = useWatch({ control: createForm.control, name: 'subtype' });

  const editForm = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: { provider: '', requiresDailyClosing: true, isActive: true },
  });

  const create = useMutation({
    mutationFn: (values: CreateForm) => {
      const branchId = given(values.branchId);
      const provider = given(values.provider);
      const last4 = given(values.accountRefLast4);
      return createWallet({
        code: values.code.trim(),
        name: values.name.trim(),
        subtype: values.subtype,
        requiresDailyClosing: values.requiresDailyClosing,
        ...(branchId === undefined ? {} : { branchId }),
        ...(provider === undefined ? {} : { provider }),
        ...(last4 === undefined ? {} : { accountRefLast4: last4 }),
      });
    },
    onSuccess: async () => {
      setAdding(false);
      setNotice('accounts.setup.added');
      createForm.reset(CREATE_DEFAULTS);
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const edit = useMutation({
    mutationFn: ({ wallet, values }: { wallet: WalletRow; values: EditForm }) =>
      updateWallet(wallet.id, {
        provider: given(values.provider) ?? null,
        requiresDailyClosing: values.requiresDailyClosing,
        isActive: values.isActive,
      }),
    onSuccess: async () => {
      setEditing(null);
      setNotice('accounts.setup.saved');
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  function openEdit(wallet: WalletRow) {
    edit.reset();
    editForm.reset({
      provider: wallet.provider ?? '',
      requiresDailyClosing: wallet.requiresDailyClosing,
      isActive: wallet.isActive,
    });
    setEditing(wallet);
  }

  const kindLabel = (value: string) =>
    value in SUBTYPE_LABELS ? a(SUBTYPE_LABELS[value as WalletSubtype]) : value;

  return (
    <div className="space-y-6">
      <AccountsHeader
        title={a('accounts.setup.title')}
        subtitle={a('accounts.setup.subtitle')}
        actions={
          mayCreate ? (
            <Button
              onClick={() => {
                create.reset();
                setAdding(true);
              }}
            >
              <Plus aria-hidden="true" />
              {a('accounts.setup.add')}
            </Button>
          ) : null
        }
      />

      {notice === null ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {a(notice)}
        </p>
      )}

      <PermissionGate
        allowed={mayCreate || mayUpdate}
        explain={{ title: a('accounts.deniedTitle'), detail: a('accounts.deniedDetail') }}
      >
        <Block title={a('accounts.setup.listHeading')} caption={a('accounts.setup.listCaption')}>
          {wallets.isPending ? (
            <LoadingRows rows={4} />
          ) : wallets.isError ? (
            <LoadFailed onRetry={() => void wallets.refetch()} />
          ) : wallets.data.items.length === 0 ? (
            <Empty label="accounts.noWallets" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{a('accounts.setup.listHeading')}</caption>
                <thead>
                  <tr className="h-9 border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-4 font-medium whitespace-nowrap">
                      {a('accounts.colWallet')}
                    </th>
                    <th scope="col" className="px-4 font-medium whitespace-nowrap">
                      {a('accounts.setup.fieldKind')}
                    </th>
                    <th scope="col" className="px-4 font-medium whitespace-nowrap">
                      {a('accounts.setup.fieldBranch')}
                    </th>
                    <th scope="col" className="px-4 font-medium whitespace-nowrap">
                      {a('accounts.setup.fieldProvider')}
                    </th>
                    <th scope="col" className="px-4 font-medium whitespace-nowrap">
                      {a('accounts.setup.colNumber')}
                    </th>
                    <th scope="col" className="px-4 font-medium whitespace-nowrap">
                      {a('accounts.setup.colDaily')}
                    </th>
                    <th scope="col" className="px-4 font-medium whitespace-nowrap">
                      {a('accounts.colStatus')}
                    </th>
                    <th scope="col" className="px-4">
                      <span className="sr-only">{t('common.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.data.items.map((wallet) => (
                    <tr key={wallet.id} className="h-9 border-b border-border last:border-b-0">
                      <td className="px-4">
                        <Link
                          to="/accounts/wallets/$accountId"
                          params={{ accountId: wallet.ledgerAccountId }}
                          className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          <span className="mr-2 font-mono text-xs text-muted-foreground">
                            {wallet.code}
                          </span>
                          {wallet.name}
                        </Link>
                      </td>
                      <td className="px-4 whitespace-nowrap">{kindLabel(wallet.subtype)}</td>
                      <td className="px-4">
                        {wallet.branchId === null
                          ? a('accounts.setup.noBranch')
                          : (branchName.get(wallet.branchId) ?? '—')}
                      </td>
                      <td className="px-4 whitespace-nowrap">{wallet.provider ?? '—'}</td>
                      <td className="px-4 font-mono text-xs whitespace-nowrap tabular-nums">
                        {wallet.accountRefMasked ?? '—'}
                      </td>
                      <td className="px-4 whitespace-nowrap">
                        {wallet.requiresDailyClosing
                          ? a('accounts.setup.yes')
                          : a('accounts.setup.no')}
                      </td>
                      <td className="px-4 whitespace-nowrap">
                        {wallet.isActive ? (
                          <StatusBadge tone="success">{a('accounts.setup.active')}</StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral">{a('accounts.inactive')}</StatusBadge>
                        )}
                      </td>
                      <td className="px-4 text-right">
                        {mayUpdate ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`${a('accounts.setup.edit')}: ${wallet.code}`}
                            onClick={() => openEdit(wallet)}
                          >
                            {a('accounts.setup.edit')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Block>
      </PermissionGate>

      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title={a('accounts.setup.addTitle')}
        description={a('accounts.setup.addDetail')}
        closeLabel={t('common.close')}
      >
        <Form<CreateForm>
          form={createForm}
          onSubmit={(values) => create.mutateAsync(values).then(() => undefined)}
          {...(create.error === null
            ? {}
            : { submitError: messageOf(create.error, a('accounts.setup.failed')) })}
        >
          <div className="space-y-4">
            <SelectField<CreateForm>
              name="subtype"
              label={a('accounts.setup.fieldKind')}
              required
              options={SUBTYPES.map((value) => ({ value, label: a(SUBTYPE_LABELS[value]) }))}
              placeholder={a('accounts.setup.fieldKind')}
            />
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
              <TextField<CreateForm>
                name="code"
                label={a('accounts.setup.fieldCode')}
                hint={a('accounts.setup.codeHint')}
                required
              />
              <TextField<CreateForm> name="name" label={a('accounts.setup.fieldName')} required />
            </div>
            <SelectField<CreateForm>
              name="branchId"
              label={a('accounts.setup.fieldBranch')}
              hint={a('accounts.setup.branchHint')}
              required={subtype === 'wallet_cash'}
              options={(branches.data?.items ?? []).map((branch) => ({
                value: branch.id,
                label: `${branch.code} · ${branch.name}`,
              }))}
              placeholder={a('accounts.setup.pickBranch')}
            />
            {subtype === 'wallet_cash' ? null : (
              <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                <TextField<CreateForm> name="provider" label={a('accounts.setup.fieldProvider')} />
                <TextField<CreateForm>
                  name="accountRefLast4"
                  label={a('accounts.setup.fieldLast4')}
                  hint={a('accounts.setup.last4Hint')}
                />
              </div>
            )}
            <Checkbox
              registration={createForm.register('requiresDailyClosing')}
              label={a('accounts.setup.dailyClosing')}
            />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? a('accounts.setup.saving') : a('accounts.setup.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing === null
            ? a('accounts.setup.editTitle')
            : `${a('accounts.setup.editTitle')} · ${editing.code}`
        }
        description={a('accounts.setup.editDetail')}
        closeLabel={t('common.close')}
      >
        {editing === null ? null : (
          <Form<EditForm>
            form={editForm}
            onSubmit={(values) =>
              edit.mutateAsync({ wallet: editing, values }).then(() => undefined)
            }
            {...(edit.error === null
              ? {}
              : { submitError: messageOf(edit.error, a('accounts.setup.failed')) })}
          >
            <div className="space-y-4">
              <TextField<EditForm> name="provider" label={a('accounts.setup.fieldProvider')} />
              <Checkbox
                registration={editForm.register('requiresDailyClosing')}
                label={a('accounts.setup.dailyClosing')}
              />
              <Checkbox
                registration={editForm.register('isActive')}
                label={a('accounts.setup.active')}
                hint={a('accounts.setup.activeHint')}
              />
            </div>
            <div className="mt-5 flex justify-end">
              <Button type="submit" disabled={edit.isPending}>
                {edit.isPending ? a('accounts.setup.saving') : a('accounts.setup.save')}
              </Button>
            </div>
          </Form>
        )}
      </Dialog>

      {/* M39a (D-634): the heads a cash entry is booked against. */}
      <HeadsSection />
    </div>
  );
}

/**
 * A boolean field. The kit has no checkbox field yet, so this is the console's
 * plain one, styled to the tokens like the catalog's, with its hint wired to the
 * control for a screen reader.
 */
function Checkbox({
  registration,
  label,
  hint,
}: {
  readonly registration: UseFormRegisterReturn;
  readonly label: string;
  readonly hint?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          {...registration}
          {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
          className="h-4 w-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
        />
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="pl-6 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
