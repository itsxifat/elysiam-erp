import { Button, Dialog, EmptyState, Select, StatusBadge, cn } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Plus, Truck } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { listWallets } from '../accounts/api.js';
import {
  connectCourier,
  courierProviders,
  listAccounts,
  saveCourierAccount,
  type ConnectCourierInput,
  type CourierAccount,
  type CourierProvider,
} from '../courier/api.js';
import { listZones } from './api.js';
import {
  connectionBody,
  connectOf,
  courierRows,
  credentialFieldsOf,
  defaultStateOf,
  defaultSwitchStartsOn,
  defaultWarning,
  makeDefaultBody,
  providerChoices,
  rowActions,
  type CourierRow,
  type CourierRowState,
  type DefaultState,
} from './couriers-logic.js';
import { useCourierSetupT, withName, type CourierSetupKey } from './couriers-messages.js';
import { useSettingsT } from './messages.js';
import { control, Field, Loadable, messageOf, SettingsPage } from './parts.js';

/**
 * Settings → Couriers, made simple (D-913; M12's accounts, D-395).
 *
 * The owner's words: choose the courier, type its keys, it is connected, and say whether it is
 * the default. So "Add courier" is two steps — Steadfast, Pathao or Carrybee, then only that
 * courier's keys and a "default" switch — and one call, `POST /v1/courier/connections`, which
 * checks the keys with the courier before it saves anything. Carrybee publishes no API, so it
 * asks for no keys: it is booked in Carrybee's own merchant panel.
 *
 * **Secrets go one way.** Keys are typed into password fields and sent; nothing sends them
 * back, and nothing prefills them. The older settings (mode, API address, webhook secret,
 * polling, settlement wallet, active) stay on each account under a collapsed "Advanced",
 * saved through `POST /v1/courier/accounts` as before.
 */

type Editing =
  | { readonly step: 'choose' }
  | {
      readonly step: 'keys';
      readonly providerCode: string;
      readonly isDefault: boolean;
      /** The account already has keys: the step replaces them. */
      readonly hasKeys: boolean;
      /** Reached from step 1, so "Back" returns there. */
      readonly fromChoice: boolean;
      readonly problem?: string;
    };

const STATE_LABEL: Readonly<Record<CourierRowState, CourierSetupKey>> = {
  connected: 'courier.setup.state.connected',
  notConnected: 'courier.setup.state.notConnected',
  panel: 'courier.setup.state.panel',
  off: 'courier.setup.state.off',
};

const STATE_TONE = {
  connected: 'success',
  notConnected: 'warning',
  panel: 'neutral',
  off: 'warning',
} as const satisfies Readonly<Record<CourierRowState, string>>;

const ACCOUNTS_KEY = ['settings', 'courier-accounts'] as const;
const PROVIDERS_KEY = ['settings', 'courier-providers'] as const;
const ZONES_KEY = ['settings', 'zones'] as const;

export function CouriersPage() {
  const t = useSettingsT();
  const c = useCourierSetupT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'CourierSettlement');
  // The default courier is every delivery zone's, so changing it also needs the zones' ability.
  const mayChangeDefault = mayUpdate && ability.can('update', 'Catalog');
  const accounts = useQuery({ queryKey: ACCOUNTS_KEY, queryFn: listAccounts });
  const providers = useQuery({ queryKey: PROVIDERS_KEY, queryFn: courierProviders });
  // Courier parties and zone defaults: Carrybee's row, and the default when it has no account.
  const zones = useQuery({ queryKey: ZONES_KEY, queryFn: listZones });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowProblem, setRowProblem] = useState<{ key: string; message: string } | null>(null);

  const rows =
    accounts.data === undefined || providers.data === undefined
      ? []
      : courierRows({
          accounts: accounts.data.items,
          defaultCourierId: accounts.data.defaultCourierId,
          providers: providers.data.items,
          parties: zones.data?.couriers ?? [],
          zones: zones.data?.zones ?? [],
          unknownName: c('courier.setup.unknownCourier'),
        });
  // The zones' default, also when it is a courier with no row here (the own rider) or the
  // zones disagree: "no row is the default" is not "there is no default".
  const defaults = defaultStateOf(accounts.data, rows);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY }),
      queryClient.invalidateQueries({ queryKey: ZONES_KEY }),
      queryClient.invalidateQueries({ queryKey: ['courier'] }),
    ]);
  };

  const makeDefault = useMutation({
    mutationFn: (row: CourierRow) => connectCourier(makeDefaultBody(row.providerCode)),
    onSuccess: async (_connection, row) => {
      setNotice(withName(c('courier.setup.madeDefault'), row.name));
      await refresh();
    },
    onError: (error, row) => {
      // A server that wants an API courier's keys again to change the default: ask for them.
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        row.provider !== undefined &&
        credentialFieldsOf(row.provider).length > 0
      ) {
        setEditing({
          step: 'keys',
          providerCode: row.providerCode,
          isDefault: true,
          hasKeys: row.account?.hasCredentials === true,
          fromChoice: false,
          problem: withName(c('courier.setup.keysForDefault'), row.name),
        });
        return;
      }
      setRowProblem({ key: row.key, message: messageOf(error, c('courier.setup.couldNotSave')) });
    },
  });

  const startAdding = () => {
    setNotice(null);
    setRowProblem(null);
    setEditing({ step: 'choose' });
  };

  const loaded = {
    isPending: accounts.isPending || providers.isPending,
    isError: accounts.isError || providers.isError,
    error: accounts.error ?? providers.error,
    data: accounts.data === undefined || providers.data === undefined ? undefined : rows,
    refetch: () => {
      void accounts.refetch();
      void providers.refetch();
      void zones.refetch();
    },
  };

  return (
    <SettingsPage tab="/settings/couriers">
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-sm text-muted-foreground">{c('courier.setup.caption')}</p>
          {mayUpdate ? (
            <Button size="sm" onClick={startAdding}>
              <Plus aria-hidden="true" />
              {c('courier.setup.add')}
            </Button>
          ) : null}
        </div>
        {mayUpdate ? null : (
          <p role="note" className="text-sm text-muted-foreground">
            {c('courier.setup.readOnly')}
          </p>
        )}
        {/* Always in the page, so a screen reader hears what lands in it. */}
        <p role="status" className="flex items-center gap-1.5 text-sm">
          {notice === null ? null : (
            <>
              <Check aria-hidden="true" className="size-4 text-success" />
              {notice}
            </>
          )}
        </p>
      </div>
      <Loadable query={loaded}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={Truck}
              title={c('courier.setup.emptyTitle')}
              detail={c('courier.setup.emptyDetail')}
              {...(mayUpdate
                ? {
                    action: (
                      <Button size="sm" onClick={startAdding}>
                        <Plus aria-hidden="true" />
                        {c('courier.setup.add')}
                      </Button>
                    ),
                  }
                : {})}
            />
          ) : (
            <ul aria-label={t('settings.nav.couriers')} className="rounded-lg border border-border">
              {list.map((row) => (
                <CourierRowItem
                  key={row.key}
                  row={row}
                  mayUpdate={mayUpdate}
                  mayChangeDefault={mayChangeDefault}
                  busy={makeDefault.isPending && makeDefault.variables.key === row.key}
                  problem={rowProblem?.key === row.key ? rowProblem.message : null}
                  onMakeDefault={() => {
                    setNotice(null);
                    setRowProblem(null);
                    makeDefault.mutate(row);
                  }}
                  onKeys={() => {
                    setNotice(null);
                    setRowProblem(null);
                    setEditing({
                      step: 'keys',
                      providerCode: row.providerCode,
                      isDefault: row.isDefault,
                      hasKeys: row.account?.hasCredentials === true,
                      fromChoice: false,
                    });
                  }}
                />
              ))}
            </ul>
          )
        }
      </Loadable>
      {editing === null || providers.data === undefined ? null : (
        <CourierDialog
          editing={editing}
          providers={providers.data.items}
          rows={rows}
          defaults={defaults}
          mayChangeDefault={mayChangeDefault}
          onStep={setEditing}
          onClose={() => setEditing(null)}
          onDone={async (provider) => {
            setEditing(null);
            const name = provider.name ?? provider.code;
            setNotice(
              withName(
                connectOf(provider) === 'panel'
                  ? c('courier.setup.added')
                  : c('courier.setup.connected'),
                name,
              ),
            );
            await refresh();
          }}
        />
      )}
    </SettingsPage>
  );
}

/** One courier: its name, whether it is connected, the default badge and what can be done. */
function CourierRowItem({
  row,
  mayUpdate,
  mayChangeDefault,
  busy,
  problem,
  onMakeDefault,
  onKeys,
}: {
  readonly row: CourierRow;
  readonly mayUpdate: boolean;
  readonly mayChangeDefault: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onMakeDefault: () => void;
  readonly onKeys: () => void;
}) {
  const c = useCourierSetupT();
  const actions = rowActions(row, mayChangeDefault);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium">{row.name}</span>
          <StatusBadge tone={STATE_TONE[row.state]}>{c(STATE_LABEL[row.state])}</StatusBadge>
          {row.isDefault ? (
            <StatusBadge tone="info">{c('courier.setup.default')}</StatusBadge>
          ) : null}
        </div>
        {mayUpdate ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions.makeDefault ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={onMakeDefault}>
                {c('courier.setup.makeDefault')}
              </Button>
            ) : null}
            {actions.keys === null ? null : (
              <Button
                size="sm"
                variant={actions.keys === 'connect' ? 'primary' : 'ghost'}
                onClick={onKeys}
              >
                {actions.keys === 'change'
                  ? c('courier.setup.changeKeys')
                  : c('courier.setup.connect')}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {row.state === 'panel' ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {withName(c('courier.setup.panelNote'), row.name)}
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive-text">
          {problem}
        </p>
      )}
      {mayUpdate && actions.advanced && row.account !== null ? (
        <details
          className="group mt-2 text-sm"
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary
            className={cn(
              'inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-muted-foreground',
              'hover:text-foreground [&::-webkit-details-marker]:hidden',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className="motion-safe:duration-fast size-3.5 group-open:rotate-90 motion-safe:transition-transform"
            />
            {c('courier.setup.advanced')}
          </summary>
          {advancedOpen ? <AdvancedSettings account={row.account} provider={row.provider} /> : null}
        </details>
      ) : null}
    </li>
  );
}

/**
 * "Add courier" and "Change keys": step 1 chooses the courier, step 2 types only its keys and
 * says whether it is the default. One dialog, so moving between the steps keeps focus inside.
 */
function CourierDialog({
  editing,
  providers,
  rows,
  defaults,
  mayChangeDefault,
  onStep,
  onClose,
  onDone,
}: {
  readonly editing: Editing;
  readonly providers: readonly CourierProvider[];
  readonly rows: readonly CourierRow[];
  readonly defaults: DefaultState;
  readonly mayChangeDefault: boolean;
  readonly onStep: (next: Editing) => void;
  readonly onClose: () => void;
  readonly onDone: (provider: CourierProvider) => Promise<void>;
}) {
  const t = useSettingsT();
  const c = useCourierSetupT();
  const id = useId();
  const formId = `${id}-form`;
  // On only for a brand with no default courier at all, and never for a role that may not
  // change it: one Save must not replace the zones' couriers unasked.
  const startsOn = mayChangeDefault && defaultSwitchStartsOn(defaults);
  const [values, setValues] = useState<Record<string, string>>({});
  const [isDefault, setIsDefault] = useState(
    editing.step === 'keys' ? editing.isDefault : startsOn,
  );
  const [problem, setProblem] = useState<string | null>(
    editing.step === 'keys' ? (editing.problem ?? null) : null,
  );

  const provider =
    editing.step === 'keys'
      ? providers.find((entry) => entry.code === editing.providerCode)
      : undefined;
  const name = provider?.name ?? (editing.step === 'keys' ? editing.providerCode : '');
  const fields = provider === undefined ? [] : credentialFieldsOf(provider);
  const panel = connectOf(provider) === 'panel';
  const courierId =
    editing.step === 'keys'
      ? (rows.find((row) => row.providerCode === editing.providerCode)?.courierId ?? null)
      : null;
  const warning = defaultWarning(defaults, courierId, c('courier.setup.unknownCourier'));
  const warningText =
    !isDefault || !mayChangeDefault || warning === null
      ? null
      : warning.kind === 'mixed'
        ? withName(c('courier.setup.defaultWarnMixed'), name)
        : withName(c('courier.setup.defaultWarnReplaces'), name).replaceAll(
            '{current}',
            warning.current,
          );

  const save = useMutation({
    mutationFn: (body: ConnectCourierInput) => connectCourier(body),
    onSuccess: async () => {
      if (provider !== undefined) await onDone(provider);
    },
    onError: (error) => setProblem(messageOf(error, c('courier.setup.couldNotSave'))),
  });

  const pick = (choice: CourierProvider) => {
    setValues({});
    setProblem(null);
    setIsDefault(startsOn);
    onStep({
      step: 'keys',
      providerCode: choice.code,
      isDefault: startsOn,
      hasKeys: false,
      fromChoice: true,
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (provider === undefined || save.isPending) return;
    const built = connectionBody(provider, values, isDefault);
    if (!built.ok) {
      setProblem(
        built.problem === 'missing' ? c('courier.setup.missing') : c('courier.setup.pairNeeded'),
      );
      return;
    }
    setProblem(null);
    save.mutate(built.body);
  };

  const title =
    editing.step === 'choose'
      ? c('courier.setup.chooseTitle')
      : withName(
          panel
            ? c('courier.setup.addTitle')
            : editing.hasKeys
              ? c('courier.setup.keysTitle')
              : c('courier.setup.connectTitle'),
          name,
        );
  const description =
    editing.step === 'choose'
      ? c('courier.setup.chooseDescription')
      : panel
        ? withName(c('courier.setup.panelNote'), name)
        : withName(c('courier.setup.keysDescription'), name);

  const footer =
    editing.step === 'choose' ? (
      <Button variant="outline" onClick={onClose}>
        {t('settings.cancel')}
      </Button>
    ) : (
      <>
        {editing.fromChoice ? (
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => {
              setProblem(null);
              onStep({ step: 'choose' });
            }}
          >
            {c('courier.setup.back')}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          {t('settings.cancel')}
        </Button>
        <Button type="submit" form={formId} disabled={save.isPending || provider === undefined}>
          {save.isPending ? c('courier.setup.checking') : t('settings.save')}
        </Button>
      </>
    );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={description}
      closeLabel={t('settings.close')}
      footer={footer}
    >
      {editing.step === 'choose' ? (
        <ChooseStep providers={providers} onPick={pick} />
      ) : (
        <form id={formId} noValidate onSubmit={submit} className="space-y-4">
          {editing.hasKeys && fields.length > 0 ? (
            <p className="text-xs text-muted-foreground">{c('courier.setup.keysNeverShown')}</p>
          ) : null}
          {fields.length === 0 ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((field, index) => {
                const firstOptional =
                  field.optional && fields.findIndex((entry) => entry.optional) === index;
                return (
                  <Field
                    key={field.name}
                    id={`${id}-${field.name}`}
                    label={field.labelKey === null ? field.name : c(field.labelKey)}
                    {...(firstOptional ? { hint: c('courier.setup.optionalLogin') } : {})}
                  >
                    <input
                      id={`${id}-${field.name}`}
                      name={field.name}
                      type={field.type}
                      autoComplete={field.autoComplete}
                      autoCapitalize="off"
                      spellCheck={false}
                      required={!field.optional}
                      maxLength={500}
                      value={values[field.name] ?? ''}
                      className={control}
                      onChange={(event) => {
                        const value = event.target.value;
                        setValues((current) => ({ ...current, [field.name]: value }));
                      }}
                    />
                  </Field>
                );
              })}
            </div>
          )}
          {problem === null ? null : (
            <p role="alert" className="text-sm text-destructive-text">
              {problem}
            </p>
          )}
          <DefaultSwitch
            id={`${id}-default`}
            checked={isDefault}
            onChange={setIsDefault}
            disabled={!mayChangeDefault}
            label={c('courier.setup.useDefault')}
            hint={
              mayChangeDefault
                ? c('courier.setup.useDefaultHint')
                : c('courier.setup.defaultNotAllowed')
            }
          />
          {warningText === null ? null : (
            <p role="note" className="text-xs text-warning-subtle-foreground">
              {warningText}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

/** Step 1: three large choices. A courier switched off on this server says so and is disabled. */
function ChooseStep({
  providers,
  onPick,
}: {
  readonly providers: readonly CourierProvider[];
  readonly onPick: (provider: CourierProvider) => void;
}) {
  const t = useSettingsT();
  const c = useCourierSetupT();
  const choices = providerChoices(providers);
  if (choices.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('settings.empty')}</p>;
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-3">
      {choices.map((choice) => {
        const panel = connectOf(choice) === 'panel';
        return (
          <li key={choice.code}>
            <button
              type="button"
              disabled={!choice.enabled}
              onClick={() => onPick(choice)}
              className={cn(
                'flex h-full w-full flex-col items-start gap-1 rounded-lg border border-border bg-card p-4 text-left',
                'motion-safe:duration-fast hover:bg-accent motion-safe:transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-card',
              )}
            >
              <Truck aria-hidden="true" className="mb-1 size-5 text-muted-foreground" />
              <span className="text-sm font-medium">{choice.name ?? choice.code}</span>
              <span className="text-xs text-muted-foreground">
                {!choice.enabled
                  ? c('courier.setup.choiceOff')
                  : panel
                    ? c('courier.setup.choicePanel')
                    : c('courier.setup.choiceApi')}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** An on/off switch: a real `role="switch"` button, named by its label, Space or Enter flips it. */
function DefaultSwitch({
  id,
  checked,
  onChange,
  disabled = false,
  label,
  hint,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly label: string;
  readonly hint: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={`${id}-hint`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent',
          'disabled:cursor-not-allowed disabled:opacity-60',
          'motion-safe:duration-fast motion-safe:transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none',
          checked ? 'bg-primary' : 'bg-input',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'motion-safe:duration-fast block size-4 rounded-full bg-background motion-safe:transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

/**
 * An account's older settings, under its collapsed "Advanced" (M12; D-395): the label, sandbox
 * or live, an API address override, the webhook secret, how soon to ask the courier for news,
 * the settlement wallet and whether the account books at all. Saved through
 * `POST /v1/courier/accounts`; the keys are left as they are (none are sent), and a blank
 * webhook secret keeps the saved one, as the server does.
 */
function AdvancedSettings({
  account,
  provider,
}: {
  readonly account: CourierAccount;
  readonly provider: CourierProvider | undefined;
}) {
  const t = useSettingsT();
  const c = useCourierSetupT();
  const id = useId();
  const queryClient = useQueryClient();
  const wallets = useQuery({ queryKey: ['settings', 'wallets'], queryFn: () => listWallets() });

  const [label, setLabel] = useState(account.label);
  const [mode, setMode] = useState<'sandbox' | 'live'>(account.mode ?? 'live');
  const [baseUrl, setBaseUrl] = useState(account.baseUrl ?? '');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [pollAfterHours, setPollAfterHours] = useState(String(account.pollAfterHours ?? 6));
  const [walletId, setWalletId] = useState(account.settlementWalletId ?? '');
  const [active, setActive] = useState(account.isActive);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const supportsWebhook = provider?.supportsWebhook ?? account.supportsWebhook === true;

  const save = useMutation({
    mutationFn: () =>
      saveCourierAccount({
        courierId: account.courierId,
        providerCode: account.providerCode,
        label: label.trim() === '' ? account.label : label.trim(),
        mode,
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
        ...(webhookSecret.trim() === '' ? {} : { webhookSecret: webhookSecret.trim() }),
        pollAfterHours: Number.parseInt(pollAfterHours, 10) || 6,
        ...(walletId === '' ? {} : { settlementWalletId: walletId }),
        isActive: active,
      }),
    onSuccess: async () => {
      setWebhookSecret('');
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
      await queryClient.invalidateQueries({ queryKey: ['courier'] });
    },
    onError: (error) => setProblem(messageOf(error, t('settings.errorDetail'))),
  });

  return (
    <form
      noValidate
      className="mt-3 space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending) return;
        setProblem(null);
        setSaved(false);
        save.mutate();
      }}
    >
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{t('settings.couriers.colKeys')}</dt>
        <dd className="font-mono">
          {account.hasCredentials === true
            ? `${t('settings.couriers.keysSet')} · ${account.credentialsFingerprint ?? ''}`
            : t('settings.couriers.keysMissing')}
        </dd>
        <dt className="text-muted-foreground">{t('settings.couriers.webhookPath')}</dt>
        <dd className="font-mono break-all">{account.webhookPath ?? '—'}</dd>
      </dl>
      {account.verified ? null : (
        <p role="note" className="text-xs text-muted-foreground">
          {t('settings.couriers.unverified')}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
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
        {supportsWebhook ? (
          <Field
            id={`${id}-webhook`}
            label={t('settings.couriers.fieldWebhookSecret')}
            {...(account.hasWebhookSecret === true
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
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant="outline" disabled={save.isPending}>
          {c('courier.setup.advancedSave')}
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {saved ? c('courier.setup.advancedSaved') : null}
        </span>
      </div>
    </form>
  );
}
