import { Button, Money, StatusBadge, cn } from '@elysium/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Copy, RadioTower, RefreshCw } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { useLocale } from '../../i18n/locale.js';
import {
  courierBalance,
  saveCourierAccount,
  webhookUrl,
  type CourierAccount,
} from '../courier/api.js';
import { dhakaDateTime } from '../courier/courier-ui.js';
import { useCourierSetupT, withName, type CourierSetupKey } from './couriers-messages.js';
import { control, messageOf } from './parts.js';

/** Settings → Couriers' own query key, so a saved token refreshes the list. */
const ACCOUNTS_KEY = ['settings', 'courier-accounts'] as const;

/**
 * A connected courier's two checks (D-918): "Check connection", which asks the courier for its
 * balance (so a person sees the saved keys work, and what the courier holds), and the live
 * parcel updates (the courier's webhook) with their steps.
 */
export function ConnectedTools({
  account,
  name,
  supportsWebhook,
  mayUpdate,
}: {
  readonly account: CourierAccount;
  readonly name: string;
  readonly supportsWebhook: boolean;
  readonly mayUpdate: boolean;
}) {
  const c = useCourierSetupT();
  const { locale } = useLocale();
  const check = useMutation({ mutationFn: () => courierBalance(account.id) });
  return (
    <div className="mt-3 space-y-3">
      {account.reportsBalance === true ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Button
            size="sm"
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            <RefreshCw aria-hidden="true" />
            {check.isPending ? c('courier.setup.checkingConnection') : c('courier.setup.check')}
          </Button>
          <span role="status" className="flex flex-wrap items-center gap-1.5 text-sm">
            {check.isSuccess ? (
              <>
                <Check aria-hidden="true" className="size-4 text-success" />
                {withName(c('courier.setup.checkWorks'), name)}
                <span className="font-medium">
                  <Money poisha={check.data.balancePoisha} locale={locale} />
                </span>
              </>
            ) : null}
            {check.isError ? (
              <span className="text-destructive-text">
                {messageOf(check.error, withName(c('courier.setup.checkFailed'), name))}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {supportsWebhook && account.webhookPath != null ? (
        <WebhookSetup account={account} name={name} mayUpdate={mayUpdate} />
      ) : null}
    </div>
  );
}

type WebhookState = 'working' | 'waiting' | 'off';

const WEBHOOK_TONE = {
  working: 'success',
  waiting: 'info',
  off: 'warning',
} as const satisfies Readonly<Record<WebhookState, string>>;

const WEBHOOK_LABEL: Readonly<Record<WebhookState, CourierSetupKey>> = {
  working: 'courier.setup.webhook.working',
  waiting: 'courier.setup.webhook.waiting',
  off: 'courier.setup.webhook.off',
};

/** Whether the courier's updates arrive: one has, a token is saved and none yet, or neither. */
export function webhookState(account: CourierAccount): WebhookState {
  if (account.lastWebhookAt != null) return 'working';
  return account.hasWebhookSecret === true ? 'waiting' : 'off';
}

/** A token nobody has to invent: 20 random bytes as hex, from the browser's own generator. */
export function newWebhookToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Live parcel updates (D-918): the courier calls the ERP when a parcel moves. Three steps, the
 * full callback URL and the token each with Copy, and whether updates arrive. The token is
 * saved as the account's webhook secret through `POST /v1/courier/accounts`, with the account's
 * other settings as they are, and is never shown again. The section is open until the first
 * update has arrived, then folds to its one line.
 */
function WebhookSetup({
  account,
  name,
  mayUpdate,
}: {
  readonly account: CourierAccount;
  readonly name: string;
  readonly mayUpdate: boolean;
}) {
  const c = useCourierSetupT();
  const id = useId();
  const queryClient = useQueryClient();
  const state = webhookState(account);
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const url = webhookUrl(account.webhookPath ?? '');

  const save = useMutation({
    mutationFn: (secret: string) =>
      saveCourierAccount({
        courierId: account.courierId,
        providerCode: account.providerCode,
        label: account.label,
        mode: account.mode ?? 'live',
        ...(account.baseUrl == null || account.baseUrl === '' ? {} : { baseUrl: account.baseUrl }),
        webhookSecret: secret,
        pollAfterHours: account.pollAfterHours ?? 1,
        ...(account.settlementWalletId == null
          ? {}
          : { settlementWalletId: account.settlementWalletId }),
        isActive: account.isActive,
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY });
    },
    onError: (error) => setProblem(messageOf(error, c('courier.setup.couldNotSave'))),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const secret = token.trim();
    if (secret.length < 16) {
      setProblem(c('courier.setup.webhook.tokenShort'));
      return;
    }
    setProblem(null);
    save.mutate(secret);
  };

  return (
    <details
      className="group rounded-md border border-border text-sm"
      {...(state === 'working' ? {} : { open: true })}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-3 py-2',
          '[&::-webkit-details-marker]:hidden',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="motion-safe:duration-fast size-3.5 text-muted-foreground group-open:rotate-90 motion-safe:transition-transform"
        />
        <RadioTower aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="font-medium">{c('courier.setup.webhook.title')}</span>
        <StatusBadge tone={WEBHOOK_TONE[state]}>{c(WEBHOOK_LABEL[state])}</StatusBadge>
        {account.lastWebhookAt == null ? null : (
          <span className="text-xs text-muted-foreground">
            {c('courier.setup.webhook.last').replace(
              '{when}',
              dhakaDateTime(account.lastWebhookAt),
            )}
          </span>
        )}
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">
        <p className="text-xs text-muted-foreground">
          {withName(c('courier.setup.webhook.intro'), name)}
        </p>
        <ol className="space-y-3">
          <Step n={1} text={c('courier.setup.webhook.step1')}>
            <CopyField id={`${id}-url`} label={c('courier.setup.webhook.url')} value={url} />
          </Step>
          <Step n={2} text={withName(c('courier.setup.webhook.step2'), name)}>
            {mayUpdate ? (
              <form noValidate onSubmit={submit} className="space-y-2">
                {account.hasWebhookSecret === true && token === '' ? (
                  <p className="text-xs text-muted-foreground">
                    {withName(c('courier.setup.webhook.tokenSaved'), name)}
                  </p>
                ) : null}
                <CopyField
                  id={`${id}-token`}
                  label={c('courier.setup.webhook.token')}
                  value={token}
                  editable
                  onChange={(value) => {
                    setSaved(false);
                    setToken(value);
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSaved(false);
                      setProblem(null);
                      setToken(newWebhookToken());
                    }}
                  >
                    {c('courier.setup.webhook.generate')}
                  </Button>
                  <Button type="submit" size="sm" disabled={save.isPending || token.trim() === ''}>
                    {c('courier.setup.webhook.save')}
                  </Button>
                  <span role="status" className="text-xs text-muted-foreground">
                    {saved ? withName(c('courier.setup.webhook.saved'), name) : null}
                  </span>
                </div>
                {problem === null ? null : (
                  <p role="alert" className="text-sm text-destructive-text">
                    {problem}
                  </p>
                )}
              </form>
            ) : (
              <p className="text-xs text-muted-foreground">{c('courier.setup.readOnly')}</p>
            )}
          </Step>
          <Step n={3} text={withName(c('courier.setup.webhook.step3'), name)} />
        </ol>
      </div>
    </details>
  );
}

function Step({
  n,
  text,
  children,
}: {
  readonly n: number;
  readonly text: string;
  readonly children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium tabular-nums"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm">{text}</p>
        {children}
      </div>
    </li>
  );
}

/** A labelled value with a Copy button; read-only unless `editable`. */
function CopyField({
  id,
  label,
  value,
  editable = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly editable?: boolean;
  readonly onChange?: (value: string) => void;
}) {
  const c = useCourierSetupT();
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          value={value}
          readOnly={!editable}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={500}
          className={cn(control, 'font-mono text-xs')}
          onFocus={(event) => {
            if (!editable) event.currentTarget.select();
          }}
          onChange={(event) => {
            setCopied(null);
            onChange?.(event.target.value);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={value === ''}
          aria-label={`${c('courier.setup.webhook.copy')}: ${label}`}
          onClick={() => {
            // No clipboard (an insecure page, an old browser) or permission refused: say so,
            // and the text stays there to select.
            const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
            if (clipboard === undefined) {
              setCopied('failed');
              return;
            }
            void clipboard.writeText(value).then(
              () => setCopied('copied'),
              () => setCopied('failed'),
            );
          }}
        >
          <Copy aria-hidden="true" />
          {copied === 'copied'
            ? c('courier.setup.webhook.copied')
            : c('courier.setup.webhook.copy')}
        </Button>
      </div>
      {copied === 'failed' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {c('courier.setup.webhook.copyFailed')}
        </p>
      ) : null}
    </div>
  );
}
