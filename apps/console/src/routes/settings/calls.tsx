import { TELEPHONY_DEFAULT_BASE_URL } from '@elysium/contracts/telephony';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  DateTime,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { env } from '../../env.js';
import {
  assignExtension,
  CONNECTIONS_KEY,
  createConnection,
  listConnections,
  listExtensions,
  TELEPHONY_KEY,
  testConnection,
  unassignExtension,
  updateConnection,
  type ConnectionView,
  type ConnectionsView,
  type ExtensionRow,
  type ExtensionsView,
} from '../calls/api.js';
import { useTelT, type TelT } from '../calls/messages.js';
import { Loadable, SettingsPage } from './parts.js';

/**
 * Settings → Calls (M47, D-830, D-846): the brand's Envo connections and who has which
 * extension. A connection's API key and webhook secret are write-only: the fields are always
 * empty, and what is stored shows as "Set" with a fingerprint. org_admin adds, changes and tests
 * connections (`create`/`update Telephony`); the desk's supervisors (org_admin, branch_manager)
 * give extensions (`update PhoneExtension`).
 */
export function CallsSettingsPage() {
  const t = useTelT();
  const ability = useAbility();
  const query = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: listConnections,
    enabled: ability.can('read', 'Telephony'),
  });
  return (
    <SettingsPage tab="/settings/calls">
      <p className="max-w-3xl text-sm text-muted-foreground">{t('tel.settings.caption')}</p>
      <Loadable query={query}>{(view) => <Connections view={view} />}</Loadable>
    </SettingsPage>
  );
}

function errorText(cause: unknown, t: TelT): string {
  return cause instanceof ApiError ? cause.message : t('tel.failed');
}

function Fingerprint({ set, print }: { readonly set: boolean; readonly print: string | null }) {
  const t = useTelT();
  return set ? (
    <StatusBadge tone="success">{t('tel.settings.set', { fingerprint: print ?? '' })}</StatusBadge>
  ) : (
    <StatusBadge tone="neutral">{t('tel.settings.notSet')}</StatusBadge>
  );
}

function Connections({ view }: { readonly view: ConnectionsView }) {
  const t = useTelT();
  const ability = useAbility();
  const [adding, setAdding] = useState(false);
  const mayCreate = ability.can('create', 'Telephony') && view.credentialsKey;
  return (
    <div className="space-y-6">
      {view.credentialsKey ? null : (
        <p
          role="alert"
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground"
        >
          {t('tel.settings.noKey')}
        </p>
      )}
      {view.provider === 'fake' ? (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {t('tel.settings.fakeProvider')}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('tel.settings.connections')}</h2>
        {mayCreate ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t('tel.settings.add')}
          </Button>
        ) : null}
      </div>
      {view.connections.length === 0 ? (
        <EmptyState title={t('tel.settings.none')} detail={t('tel.settings.noneDetail')} />
      ) : (
        view.connections.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            credentialsKey={view.credentialsKey}
          />
        ))
      )}
      {adding ? <ConnectionDialog connection={null} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function ConnectionCard({
  connection,
  credentialsKey,
}: {
  readonly connection: ConnectionView;
  readonly credentialsKey: boolean;
}) {
  const t = useTelT();
  const ids = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const [result, setResult] = useState<{
    readonly tone: 'ok' | 'error';
    readonly text: string;
  } | null>(null);
  const mayUpdate = ability.can('update', 'Telephony');
  const webhook = `${env.VITE_API_URL.replace(/\/+$/, '')}${connection.webhookPath}`;
  const test = useMutation({
    mutationFn: () => testConnection(connection.id),
    onSuccess: (answer) => {
      setResult({
        tone: answer.missingScopes.length === 0 ? 'ok' : 'error',
        text: [
          t('tel.settings.testResult', {
            extensions: answer.extensions.length,
            numbers: answer.numbers.length,
            server: answer.sipServer?.name ?? connection.name,
          }),
          answer.missingScopes.length === 0
            ? ''
            : t('tel.settings.missingScopes', { scopes: answer.missingScopes.join(', ') }),
        ]
          .filter((part) => part !== '')
          .join(' '),
      });
    },
    onError: (cause) => setResult({ tone: 'error', text: errorText(cause, t) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY }),
  });
  const failure = connection.lastSignatureFailure;
  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="space-y-4 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 id={`${ids}-title`} className="flex items-center gap-2 text-sm font-semibold">
            {connection.name}
            <StatusBadge tone={connection.enabled ? 'success' : 'neutral'}>
              {connection.enabled ? t('tel.settings.on') : t('tel.settings.off')}
            </StatusBadge>
          </h3>
          <p className="text-xs break-all text-muted-foreground">{connection.baseUrl}</p>
        </div>
        {mayUpdate ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? t('tel.settings.testing') : t('tel.settings.test')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!credentialsKey}
              onClick={() => setEditing(true)}
            >
              {t('tel.settings.edit')}
            </Button>
          </div>
        ) : null}
      </div>
      {result === null ? null : (
        <p
          role={result.tone === 'error' ? 'alert' : 'status'}
          className={
            result.tone === 'error'
              ? 'text-sm text-destructive'
              : 'text-sm text-success-subtle-foreground'
          }
        >
          {result.text}
        </p>
      )}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.apiKey')}</dt>
          <dd>
            <Fingerprint set={connection.apiKeySet} print={connection.apiKeyFingerprint} />
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.webhookSecret')}</dt>
          <dd>
            <Fingerprint
              set={connection.webhookSecretSet}
              print={connection.webhookSecretFingerprint}
            />
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.sipServer')}</dt>
          <dd>{connection.envoServer?.name ?? t('tel.settings.never')}</dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.lastTest')}</dt>
          <dd>
            {connection.lastTest === null ? (
              t('tel.settings.never')
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <StatusBadge tone={connection.lastTest.ok ? 'success' : 'danger'}>
                  {connection.lastTest.ok ? t('tel.settings.testOk') : t('tel.failed')}
                </StatusBadge>
                <DateTime value={connection.lastTest.at} />
              </span>
            )}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.lastWebhook')}</dt>
          <dd>
            {connection.lastWebhook === null ? (
              t('tel.settings.never')
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{connection.lastWebhook.event}</span>
                <DateTime value={connection.lastWebhook.at} />
              </span>
            )}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.lastFailure')}</dt>
          <dd>
            {failure === null ? (
              t('tel.settings.never')
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <StatusBadge tone="danger">{reasonText(t, failure.reason)}</StatusBadge>
                <DateTime value={failure.at} />
              </span>
            )}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.lastSync')}</dt>
          <dd>
            {connection.lastSync === null ? (
              t('tel.settings.never')
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <DateTime value={connection.lastSync.at} />
                {connection.lastSync.error === null ? null : (
                  <span className="text-xs text-destructive">{connection.lastSync.error}</span>
                )}
              </span>
            )}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="text-xs text-muted-foreground">{t('tel.settings.retention')}</dt>
          <dd className="tabular-nums">{connection.recordingRetentionDays}</dd>
        </div>
      </dl>

      <div className="space-y-1.5">
        <h4 className="text-xs font-medium">{t('tel.settings.webhook')}</h4>
        <p className="text-xs text-muted-foreground">{t('tel.settings.webhookDetail')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border border-border bg-muted px-2 py-1 text-xs break-all">
            {webhook}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              // No clipboard (an insecure page, an old browser) or permission refused: say so,
              // and the address stays there to select.
              const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
              if (clipboard === undefined) {
                setCopied('failed');
                return;
              }
              void clipboard.writeText(webhook).then(
                () => setCopied('copied'),
                () => setCopied('failed'),
              );
            }}
          >
            {copied === 'copied' ? t('tel.settings.copied') : t('tel.settings.copy')}
          </Button>
          {copied === 'failed' ? (
            <span role="status" className="text-xs text-muted-foreground">
              {t('tel.settings.copyFailed')}
            </span>
          ) : null}
        </div>
      </div>

      {ability.can('read', 'PhoneExtension') ? (
        <ExtensionsBlock connectionId={connection.id} />
      ) : null}
      {editing ? (
        <ConnectionDialog connection={connection} onClose={() => setEditing(false)} />
      ) : null}
    </section>
  );
}

function reasonText(t: TelT, reason: string | null): string {
  if (reason === null) return '';
  switch (reason) {
    case 'bad_signature':
      return t('tel.settings.reason.bad_signature');
    case 'stale':
      return t('tel.settings.reason.stale');
    case 'missing':
      return t('tel.settings.reason.missing');
    case 'no_secret':
      return t('tel.settings.reason.no_secret');
    default:
      return reason;
  }
}

function ConnectionDialog({
  connection,
  onClose,
}: {
  readonly connection: ConnectionView | null;
  readonly onClose: () => void;
}) {
  const t = useTelT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(connection?.name ?? t('tel.settings.defaultName'));
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? TELEPHONY_DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [retention, setRetention] = useState(String(connection?.recordingRetentionDays ?? 365));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        enabled,
        recordingRetentionDays: Number(retention),
        ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
        ...(secret.trim() === '' ? {} : { webhookSecret: secret.trim() }),
      };
      return connection === null ? createConnection(input) : updateConnection(connection.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY });
      onClose();
    },
    onError: (cause) => setProblem(errorText(cause, t)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    save.mutate();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        connection === null
          ? t('tel.settings.addTitle')
          : t('tel.settings.editTitle', { name: connection.name })
      }
      closeLabel={t('tel.close')}
    >
      <form className="space-y-3" onSubmit={submit}>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-name`} required>
            {t('tel.settings.name')}
          </Label>
          <Input
            id={`${ids}-name`}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-url`} required>
            {t('tel.settings.baseUrl')}
          </Label>
          <Input
            id={`${ids}-url`}
            value={baseUrl}
            inputMode="url"
            autoComplete="off"
            aria-describedby={`${ids}-url-hint`}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <p id={`${ids}-url-hint`} className="text-xs text-muted-foreground">
            {t('tel.settings.baseUrlHint')}
          </p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${ids}-key`} required={connection === null}>
              {t('tel.settings.apiKey')}
            </Label>
            {connection === null ? null : (
              <Fingerprint set={connection.apiKeySet} print={connection.apiKeyFingerprint} />
            )}
          </div>
          <Input
            id={`${ids}-key`}
            type="password"
            autoComplete="off"
            value={apiKey}
            aria-describedby={`${ids}-key-hint`}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <p id={`${ids}-key-hint`} className="text-xs text-muted-foreground">
            {t('tel.settings.apiKeyHint')}
          </p>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${ids}-secret`}>{t('tel.settings.webhookSecret')}</Label>
            {connection === null ? null : (
              <Fingerprint
                set={connection.webhookSecretSet}
                print={connection.webhookSecretFingerprint}
              />
            )}
          </div>
          <Input
            id={`${ids}-secret`}
            type="password"
            autoComplete="off"
            value={secret}
            aria-describedby={`${ids}-secret-hint`}
            onChange={(event) => setSecret(event.target.value)}
          />
          <p id={`${ids}-secret-hint`} className="text-xs text-muted-foreground">
            {t('tel.settings.webhookSecretHint')}{' '}
            {connection === null ? '' : t('tel.settings.keepBlank')}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-days`}>{t('tel.settings.retention')}</Label>
          <Input
            id={`${ids}-days`}
            type="number"
            min={30}
            max={3650}
            value={retention}
            className="w-32 tabular-nums"
            onChange={(event) => setRetention(event.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm" htmlFor={`${ids}-on`}>
          <Checkbox
            id={`${ids}-on`}
            checked={enabled}
            onCheckedChange={(value) => setEnabled(value === true)}
          />
          {t('tel.settings.enabled')}
        </label>
        {problem === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('tel.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? t('tel.saving') : t('tel.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ExtensionsBlock({ connectionId }: { readonly connectionId: string }) {
  const t = useTelT();
  const query = useQuery({
    queryKey: [...TELEPHONY_KEY, 'extensions', connectionId],
    queryFn: () => listExtensions(connectionId),
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <h4 className="text-sm font-semibold">{t('tel.settings.extensions')}</h4>
      <p className="text-xs text-muted-foreground">{t('tel.settings.extensionsDetail')}</p>
      {query.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(query.error, t)}
        </p>
      ) : (
        <ExtensionsTable view={query.data} connectionId={connectionId} />
      )}
    </div>
  );
}

function ExtensionsTable({
  view,
  connectionId,
}: {
  readonly view: ExtensionsView;
  readonly connectionId: string;
}) {
  const t = useTelT();
  const ability = useAbility();
  const mayAssign = ability.can('update', 'PhoneExtension');
  const free = view.people.filter((person) => person.extension === null);
  return (
    <div className="space-y-2">
      {view.liveError === null ? null : (
        <p
          role="status"
          className="rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
        >
          {t('tel.settings.liveError', { reason: view.liveError })}
        </p>
      )}
      {view.extensions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('tel.settings.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {view.extensions.map((row) => (
            <ExtensionItem
              key={row.extension}
              row={row}
              connectionId={connectionId}
              free={free}
              mayAssign={mayAssign}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExtensionItem({
  row,
  connectionId,
  free,
  mayAssign,
}: {
  readonly row: ExtensionRow;
  readonly connectionId: string;
  readonly free: ExtensionsView['people'];
  readonly mayAssign: boolean;
}) {
  const t = useTelT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [person, setPerson] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const done = async () => {
    setProblem(null);
    await queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY });
  };
  const give = useMutation({
    mutationFn: () => assignExtension(connectionId, row.extension, person),
    onSuccess: done,
    onError: (cause) => setProblem(errorText(cause, t)),
  });
  const takeOff = useMutation({
    mutationFn: () => unassignExtension(connectionId, row.extension),
    onSuccess: done,
    onError: (cause) => setProblem(errorText(cause, t)),
  });
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <span className="w-14 font-medium tabular-nums">{row.extension}</span>
      <span className="min-w-24 text-muted-foreground">{row.name}</span>
      <StatusBadge tone={row.online ? 'success' : 'neutral'}>
        {row.online ? t('tel.ext.online') : t('tel.ext.offline')}
      </StatusBadge>
      {row.inEnvo ? null : <StatusBadge tone="warning">{t('tel.settings.notInEnvo')}</StatusBadge>}
      <span className="ml-auto inline-flex flex-wrap items-center gap-2">
        {row.assignee !== null ? (
          <>
            <span>{row.assignee.name ?? '—'}</span>
            {row.assignee.current ? null : (
              <StatusBadge tone="warning">{t('tel.ext.left')}</StatusBadge>
            )}
            {mayAssign ? (
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                {t('tel.settings.unassign')}
              </Button>
            ) : null}
          </>
        ) : mayAssign && free.length > 0 ? (
          <>
            <span className="w-44">
              <Select
                id={`${ids}-person`}
                aria-label={t('tel.settings.choosePerson')}
                value={person}
                onValueChange={setPerson}
                options={[
                  { value: '', label: t('tel.settings.choosePerson') },
                  ...free.map((candidate) => ({ value: candidate.id, label: candidate.name })),
                ]}
              />
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={person === '' || give.isPending}
              onClick={() => give.mutate()}
            >
              {t('tel.settings.assign')}
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground">{t('tel.ext.nobody')}</span>
        )}
      </span>
      {problem === null ? null : (
        <p role="alert" className="w-full text-xs text-destructive">
          {problem}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('tel.settings.unassign')}
        description={t('tel.settings.unassignConfirm', {
          extension: row.extension,
          name: row.assignee?.name ?? '',
        })}
        confirmLabel={t('tel.settings.unassign')}
        cancelLabel={t('tel.cancel')}
        closeLabel={t('tel.close')}
        destructive
        onConfirm={async () => {
          // A refusal closes the dialog and is said in the row (onError), not behind the dialog.
          await takeOff.mutateAsync().catch(() => undefined);
        }}
      />
    </li>
  );
}
