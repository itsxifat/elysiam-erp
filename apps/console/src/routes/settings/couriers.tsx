import { Button, Dialog, Select, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { listWallets } from '../accounts/api.js';
import {
  courierProviders,
  listAccounts,
  saveCourierAccount,
  type CourierAccount,
  type CourierProvider,
} from '../courier/api.js';
import { listZones, type CourierParty } from './api.js';
import { useSettingsT } from './messages.js';
import {
  control,
  Empty,
  Field,
  headClass,
  Loadable,
  messageOf,
  rowClass,
  SettingsPage,
  tableClass,
} from './parts.js';

/**
 * Courier accounts: which adapter books a courier's parcels, with which keys (M12; D-395).
 *
 * **Secrets go one way.** API keys and the webhook secret are typed into password fields and
 * sent; nothing sends them back. The list says whether a key is set and shows its fingerprint
 * (twelve hex characters of a digest), which is how an operator checks the key in the vault is
 * the key in the database without either being displayed. Leaving a key blank on an edit keeps
 * the stored one, as the server does.
 *
 * An adapter not built from the courier's own documentation (`verified: false`, D-176, D-200)
 * says so, and activating it is refused by the server unless the installation enabled it.
 */
export function CouriersPage() {
  const t = useSettingsT();
  const ability = useAbility();
  const accounts = useQuery({ queryKey: ['settings', 'courier-accounts'], queryFn: listAccounts });
  const providers = useQuery({
    queryKey: ['settings', 'courier-providers'],
    queryFn: courierProviders,
  });
  const parties = useQuery({ queryKey: ['settings', 'zones'], queryFn: listZones });
  const [editing, setEditing] = useState<CourierAccount | 'new' | null>(null);
  const mayUpdate = ability.can('update', 'CourierSettlement');

  const couriers = parties.data?.couriers ?? [];
  const nameOf = (courierId: string) =>
    couriers.find((courier) => courier.id === courierId)?.name ?? '—';

  return (
    <SettingsPage tab="/settings/couriers">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{t('settings.couriers.caption')}</p>
        {mayUpdate ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            {t('settings.couriers.add')}
          </Button>
        ) : null}
      </div>
      <Loadable query={accounts}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <table className={tableClass}>
              <caption className="sr-only">{t('settings.nav.couriers')}</caption>
              <thead>
                <tr className={headClass}>
                  <th className="py-1.5 font-medium">{t('settings.couriers.colCourier')}</th>
                  <th className="py-1.5 font-medium">{t('settings.couriers.colProvider')}</th>
                  <th className="py-1.5 font-medium">{t('settings.couriers.colMode')}</th>
                  <th className="py-1.5 font-medium">{t('settings.couriers.colKeys')}</th>
                  <th className="py-1.5 font-medium">{t('settings.couriers.webhookPath')}</th>
                  <th className="py-1.5 font-medium">{t('settings.colStatus')}</th>
                  <th className="py-1.5">
                    <span className="sr-only">{t('settings.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((account) => (
                  <tr key={account.id} className={rowClass}>
                    <td className="py-1.5">
                      <span className="block font-medium">{nameOf(account.courierId)}</span>
                      <span className="block text-xs text-muted-foreground">{account.label}</span>
                    </td>
                    <td className="py-1.5">
                      <span className="font-mono text-xs">{account.providerCode}</span>
                      {account.verified ? null : (
                        <StatusBadge tone="warning" className="ml-2">
                          {t('settings.couriers.unverifiedBadge')}
                        </StatusBadge>
                      )}
                    </td>
                    <td className="py-1.5">
                      {account.mode === 'live'
                        ? t('settings.couriers.modeLive')
                        : t('settings.couriers.modeSandbox')}
                    </td>
                    <td className="py-1.5">
                      {account.hasCredentials === true ? (
                        <span className="font-mono text-xs">
                          {t('settings.couriers.keysSet')} · {account.credentialsFingerprint ?? ''}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t('settings.couriers.keysMissing')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 font-mono text-xs break-all">
                      {account.webhookPath ?? '—'}
                    </td>
                    <td className="py-1.5">
                      <StatusBadge tone={account.isActive ? 'success' : 'neutral'}>
                        {account.isActive ? t('settings.active') : t('settings.inactive')}
                      </StatusBadge>
                    </td>
                    <td className="py-1.5 text-right">
                      {mayUpdate ? (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(account)}>
                          {t('settings.edit')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Loadable>
      {editing === null ? null : (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          couriers={couriers}
          providers={providers.data?.items ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsPage>
  );
}

function AccountDialog({
  account,
  couriers,
  providers,
  onClose,
}: {
  readonly account: CourierAccount | null;
  readonly couriers: readonly CourierParty[];
  readonly providers: readonly CourierProvider[];
  readonly onClose: () => void;
}) {
  const t = useSettingsT();
  const id = useId();
  const queryClient = useQueryClient();
  const wallets = useQuery({ queryKey: ['settings', 'wallets'], queryFn: () => listWallets() });

  const [courierId, setCourierId] = useState(account?.courierId ?? '');
  const [providerCode, setProviderCode] = useState(account?.providerCode ?? '');
  const [label, setLabel] = useState(account?.label ?? '');
  const [mode, setMode] = useState<'sandbox' | 'live'>(account?.mode ?? 'sandbox');
  const [baseUrl, setBaseUrl] = useState(account?.baseUrl ?? '');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [webhookSecret, setWebhookSecret] = useState('');
  const [pollAfterHours, setPollAfterHours] = useState(String(account?.pollAfterHours ?? 6));
  const [walletId, setWalletId] = useState(account?.settlementWalletId ?? '');
  const [active, setActive] = useState(account?.isActive ?? false);
  const [problem, setProblem] = useState<string | null>(null);

  const provider = providers.find((entry) => entry.code === providerCode);
  const typed = Object.fromEntries(
    Object.entries(credentials).filter(([, value]) => value.trim() !== ''),
  );

  const save = useMutation({
    mutationFn: () =>
      saveCourierAccount({
        courierId,
        providerCode,
        label: label.trim(),
        mode,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(Object.keys(typed).length === 0 ? {} : { credentials: typed }),
        ...(webhookSecret.trim() === '' ? {} : { webhookSecret: webhookSecret.trim() }),
        pollAfterHours: Number.parseInt(pollAfterHours, 10) || 6,
        ...(walletId === '' ? {} : { settlementWalletId: walletId }),
        isActive: active,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'courier-accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['courier'] });
      onClose();
    },
    onError: (error) => setProblem(messageOf(error, t('settings.errorDetail'))),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('settings.couriers.formTitle')}
      closeLabel={t('settings.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              if (courierId === '' || providerCode === '' || label.trim() === '') {
                setProblem(t('settings.couriers.invalid'));
                return;
              }
              setProblem(null);
              save.mutate();
            }}
          >
            {t('settings.save')}
          </Button>
        </>
      }
    >
      {couriers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.couriers.noCouriers')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${id}-courier`} label={t('settings.couriers.colCourier')}>
            <Select
              id={`${id}-courier`}
              value={courierId}
              disabled={account !== null}
              placeholder={t('settings.choose')}
              onValueChange={setCourierId}
              options={couriers.map((courier) => ({ value: courier.id, label: courier.name }))}
            />
          </Field>
          <Field id={`${id}-provider`} label={t('settings.couriers.colProvider')}>
            <Select
              id={`${id}-provider`}
              value={providerCode}
              placeholder={t('settings.choose')}
              onValueChange={(value) => {
                setProviderCode(value);
                setCredentials({});
              }}
              options={providers.map((entry) => ({ value: entry.code, label: entry.code }))}
            />
          </Field>
          {provider !== undefined && !provider.verified ? (
            <p role="note" className="text-xs text-warning-subtle-foreground sm:col-span-2">
              {t('settings.couriers.unverified')}
            </p>
          ) : null}
          <Field id={`${id}-label`} label={t('settings.couriers.fieldLabel')}>
            <input
              id={`${id}-label`}
              value={label}
              maxLength={120}
              className={control}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field id={`${id}-mode`} label={t('settings.couriers.colMode')}>
            <Select
              id={`${id}-mode`}
              value={mode}
              onValueChange={(value) => setMode(value === 'live' ? 'live' : 'sandbox')}
              options={[
                { value: 'sandbox', label: t('settings.couriers.modeSandbox') },
                { value: 'live', label: t('settings.couriers.modeLive') },
              ]}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field id={`${id}-base`} label={t('settings.couriers.fieldBaseUrl')}>
              <input
                id={`${id}-base`}
                type="url"
                value={baseUrl}
                maxLength={300}
                className={control}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
          </div>
          {(provider?.credentialFields ?? []).map((field) => (
            <Field
              key={field}
              id={`${id}-cred-${field}`}
              label={field}
              {...(account?.hasCredentials === true
                ? { hint: t('settings.couriers.keepSecret') }
                : {})}
            >
              <input
                id={`${id}-cred-${field}`}
                type="password"
                autoComplete="new-password"
                value={credentials[field] ?? ''}
                maxLength={500}
                className={control}
                onChange={(event) =>
                  setCredentials((current) => ({ ...current, [field]: event.target.value }))
                }
              />
            </Field>
          ))}
          {provider?.supportsWebhook === true ? (
            <Field
              id={`${id}-webhook`}
              label={t('settings.couriers.fieldWebhookSecret')}
              {...(account?.hasWebhookSecret === true
                ? { hint: t('settings.couriers.keepSecret') }
                : {})}
            >
              <input
                id={`${id}-webhook`}
                type="password"
                autoComplete="new-password"
                value={webhookSecret}
                maxLength={500}
                className={control}
                onChange={(event) => setWebhookSecret(event.target.value)}
              />
            </Field>
          ) : null}
          <Field id={`${id}-poll`} label={t('settings.couriers.fieldPoll')}>
            <input
              id={`${id}-poll`}
              inputMode="numeric"
              value={pollAfterHours}
              className={`${control} tabular-nums`}
              onChange={(event) => setPollAfterHours(event.target.value)}
            />
          </Field>
          <Field id={`${id}-wallet`} label={t('settings.couriers.fieldWallet')}>
            <Select
              id={`${id}-wallet`}
              value={walletId}
              placeholder={t('settings.choose')}
              onValueChange={setWalletId}
              options={[
                // The wallet is optional: "Choose…" stays a choice that clears it.
                { value: '', label: t('settings.choose') },
                ...(wallets.data?.items ?? [])
                  .filter((wallet) => wallet.subtype !== 'wallet_cash')
                  .map((wallet) => ({ value: wallet.id, label: wallet.name })),
              ]}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2" htmlFor={`${id}-active`}>
            <input
              id={`${id}-active`}
              type="checkbox"
              checked={active}
              className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setActive(event.target.checked)}
            />
            {t('settings.couriers.fieldActive')}
          </label>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
