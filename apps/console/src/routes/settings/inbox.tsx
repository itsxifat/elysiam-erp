import { Button, Input, Label, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { env } from '../../env.js';
import {
  CHANNELS_KEY,
  getChannels,
  saveChannel,
  saveMetaApp,
  type ChannelKind,
  type ChannelsView,
} from '../inbox/api.js';
import { useInboxT, type InboxKey } from '../inbox/messages.js';
import { Loadable, SettingsPage } from './parts.js';

/**
 * Settings → Inbox (M42, D-733): the brand's Meta app secret and verify token, the webhook
 * address to paste into Meta, and each channel's id and token. Every secret is write-only: the
 * field is always empty, and what is stored shows as "Set" with a fingerprint. org_admin only
 * (`read`/`update InboxChannel`).
 */
export function InboxSettingsPage() {
  const t = useInboxT();
  const query = useQuery({ queryKey: CHANNELS_KEY, queryFn: getChannels });
  return (
    <SettingsPage tab="/settings/inbox">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('inbox.settings.caption')}</p>
      <Loadable query={query}>{(view) => <InboxSettings view={view} />}</Loadable>
    </SettingsPage>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause);
}

function Fingerprint({
  set,
  fingerprint,
}: {
  readonly set: boolean;
  readonly fingerprint: string | null;
}) {
  const t = useInboxT();
  return set ? (
    <StatusBadge tone="success">
      {t('inbox.settings.set', { fingerprint: fingerprint ?? '' })}
    </StatusBadge>
  ) : (
    <StatusBadge tone="neutral">{t('inbox.settings.notSet')}</StatusBadge>
  );
}

function InboxSettings({ view }: { readonly view: ChannelsView }) {
  const t = useInboxT();
  const ability = useAbility();
  const mayEdit = ability.can('update', 'InboxChannel');
  const webhook = `${env.VITE_API_URL.replace(/\/+$/, '')}${view.webhookPath}`;
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-6">
      {view.credentialsKey ? null : (
        <p
          role="alert"
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground"
        >
          {t('inbox.settings.noKey')}
        </p>
      )}
      {view.provider === 'fake' ? (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {t('inbox.settings.fakeProvider')}
        </p>
      ) : null}

      <section className="space-y-2" aria-labelledby="inbox-webhook">
        <h2 id="inbox-webhook" className="text-sm font-semibold">
          {t('inbox.settings.webhook')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('inbox.settings.webhookDetail')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border border-border bg-muted px-2 py-1 text-xs break-all">
            {webhook}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard?.writeText(webhook).then(() => setCopied(true));
            }}
          >
            {copied ? t('inbox.settings.copied') : t('inbox.settings.copy')}
          </Button>
        </div>
      </section>

      <AppForm view={view} mayEdit={mayEdit && view.credentialsKey} />
      {(['messenger', 'instagram', 'whatsapp'] as const).map((kind) => (
        <ChannelForm
          key={kind}
          kind={kind}
          view={view}
          mayEdit={mayEdit && (view.credentialsKey || kind === 'instagram')}
        />
      ))}
    </div>
  );
}

function AppForm({ view, mayEdit }: { readonly view: ChannelsView; readonly mayEdit: boolean }) {
  const t = useInboxT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const save = useMutation({
    mutationFn: () =>
      saveMetaApp({
        ...(secret.trim() === '' ? {} : { appSecret: secret.trim() }),
        ...(token.trim() === '' ? {} : { verifyToken: token.trim() }),
      }),
    onSuccess: async () => {
      setSecret('');
      setToken('');
      setMessage({ tone: 'ok', text: t('inbox.saved') });
      await queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
    onError: (cause) => setMessage({ tone: 'error', text: errorText(cause) }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setMessage(null);
    if (secret.trim() === '' && token.trim() === '') return;
    save.mutate();
  };
  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      onSubmit={submit}
      aria-labelledby={`${ids}-title`}
    >
      <h2 id={`${ids}-title`} className="text-sm font-semibold">
        {t('inbox.settings.app')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('inbox.settings.appDetail')}</p>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${ids}-secret`}>{t('inbox.settings.appSecret')}</Label>
          <Fingerprint set={view.app.appSecretSet} fingerprint={view.app.appSecretFingerprint} />
        </div>
        <Input
          id={`${ids}-secret`}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          disabled={!mayEdit}
          aria-describedby={`${ids}-keep`}
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${ids}-token`}>{t('inbox.settings.verifyToken')}</Label>
          <Fingerprint
            set={view.app.verifyTokenSet}
            fingerprint={view.app.verifyTokenFingerprint}
          />
        </div>
        <Input
          id={`${ids}-token`}
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={!mayEdit}
          aria-describedby={`${ids}-keep`}
        />
      </div>
      <p id={`${ids}-keep`} className="text-xs text-muted-foreground">
        {t('inbox.settings.keepBlank')}
      </p>
      <Status message={message} />
      {mayEdit ? (
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? t('inbox.saving') : t('inbox.settings.saveApp')}
        </Button>
      ) : null}
    </form>
  );
}

const CHANNEL_TEXT: Readonly<
  Record<
    ChannelKind,
    {
      readonly title: InboxKey;
      readonly detail: InboxKey;
      readonly id: InboxKey;
      readonly token: boolean;
    }
  >
> = {
  messenger: {
    title: 'inbox.settings.messenger',
    detail: 'inbox.settings.messengerDetail',
    id: 'inbox.settings.pageId',
    token: true,
  },
  instagram: {
    title: 'inbox.settings.instagram',
    detail: 'inbox.settings.instagramDetail',
    id: 'inbox.settings.igId',
    token: false,
  },
  whatsapp: {
    title: 'inbox.settings.whatsapp',
    detail: 'inbox.settings.whatsappDetail',
    id: 'inbox.settings.phoneNumberId',
    token: true,
  },
};

function ChannelForm({
  kind,
  view,
  mayEdit,
}: {
  readonly kind: ChannelKind;
  readonly view: ChannelsView;
  readonly mayEdit: boolean;
}) {
  const t = useInboxT();
  const ids = useId();
  const queryClient = useQueryClient();
  const current = view.channels.find((channel) => channel.kind === kind);
  const text = CHANNEL_TEXT[kind];
  const [externalId, setExternalId] = useState(current?.externalId ?? '');
  // A channel not set up yet starts switched on: saving its id is the point of the form.
  const [enabled, setEnabled] = useState(current?.configured === true ? current.enabled : true);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const save = useMutation({
    mutationFn: () =>
      saveChannel(kind, {
        externalId: externalId.trim(),
        enabled,
        ...(token.trim() === '' ? {} : { accessToken: token.trim() }),
      }),
    onSuccess: async () => {
      setToken('');
      setMessage({ tone: 'ok', text: t('inbox.saved') });
      await queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
    onError: (cause) => setMessage({ tone: 'error', text: errorText(cause) }),
  });
  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      aria-labelledby={`${ids}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        setMessage(null);
        save.mutate();
      }}
    >
      <h2 id={`${ids}-title`} className="text-sm font-semibold">
        {t(text.title)}
      </h2>
      <p className="text-sm text-muted-foreground">{t(text.detail)}</p>
      <div className="space-y-1">
        <Label htmlFor={`${ids}-id`}>{t(text.id)}</Label>
        <Input
          id={`${ids}-id`}
          inputMode="numeric"
          autoComplete="off"
          value={externalId}
          onChange={(event) => setExternalId(event.target.value)}
          disabled={!mayEdit}
          required
        />
      </div>
      {text.token ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${ids}-token`}>{t('inbox.settings.token')}</Label>
            <Fingerprint
              set={current?.tokenSet ?? false}
              fingerprint={current?.tokenFingerprint ?? null}
            />
          </div>
          <Input
            id={`${ids}-token`}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            disabled={!mayEdit}
            aria-describedby={`${ids}-keep`}
          />
          <p id={`${ids}-keep`} className="text-xs text-muted-foreground">
            {t('inbox.settings.keepBlank')}
          </p>
        </div>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded-sm accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          disabled={!mayEdit}
        />
        {t('inbox.settings.enabled')}
      </label>
      <Status message={message} />
      {mayEdit ? (
        <Button type="submit" size="sm" disabled={save.isPending || externalId.trim() === ''}>
          {save.isPending ? t('inbox.saving') : t('inbox.settings.saveChannel')}
        </Button>
      ) : null}
    </form>
  );
}

function Status({ message }: { readonly message: { tone: 'ok' | 'error'; text: string } | null }) {
  if (message === null) return null;
  return (
    <p
      role={message.tone === 'error' ? 'alert' : 'status'}
      className={
        message.tone === 'error' ? 'text-sm text-destructive-text' : 'text-sm text-muted-foreground'
      }
    >
      {message.text}
    </p>
  );
}
