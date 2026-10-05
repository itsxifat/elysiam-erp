import { Button, Checkbox, DateTime, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAbility, useOrgWide } from '../../auth/session.js';
import {
  getEmailSettings,
  listEmails,
  saveEmailSettings,
  sendTestEmail,
  type EmailLogRow,
  type EmailSettings,
} from './api.js';
import { useWebsiteT, type WebsiteMessageKey } from './messages.js';
import { control, Empty, Field, Loadable, NamedSection, Problem, WebsitePage } from './parts.js';
import '../../i18n/website.js';

/**
 * Website → Email (M34, D-529): the brand's own email server, which sends shoppers their email
 * codes, password links and order news, a test button, and what went out.
 *
 * Changing the server is an org admin's (`update WebsiteCredentials`): whoever points it
 * elsewhere receives every reset link. The password is write-only, shown as a fingerprint.
 */
export function WebsiteEmailPage() {
  const settings = useQuery({ queryKey: ['website', 'email'], queryFn: getEmailSettings });
  // The shoppers' addresses in the log are for those who see every buyer (ledger audit W6).
  const seesLog = useOrgWide()('read', 'Customer');
  const log = useQuery({
    queryKey: ['website', 'email', 'log'],
    queryFn: listEmails,
    enabled: seesLog,
  });
  return (
    <WebsitePage tab="/website/email" wide>
      <Loadable query={settings}>{(value) => <ServerForm value={value} />}</Loadable>
      {seesLog ? <Loadable query={log}>{(value) => <Log items={value.items} />}</Loadable> : null}
    </WebsitePage>
  );
}

function ServerForm({ value }: { readonly value: EmailSettings }) {
  const t = useWebsiteT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'WebsiteCredentials');
  const [enabled, setEnabled] = useState(value.enabled);
  const [host, setHost] = useState(value.host);
  const [port, setPort] = useState(String(value.port));
  const [secure, setSecure] = useState(value.secure);
  const [username, setUsername] = useState(value.username);
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState(value.fromName);
  const [fromEmail, setFromEmail] = useState(value.fromEmail);
  const [testTo, setTestTo] = useState('');
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      saveEmailSettings({
        enabled,
        host: host.trim(),
        port: Number.parseInt(port, 10) || 0,
        secure,
        username: username.trim(),
        ...(password === '' ? {} : { password }),
        fromName: fromName.trim(),
        fromEmail: fromEmail.trim(),
      }),
    onMutate: () => setSaved(false),
    onSuccess: (next) => {
      queryClient.setQueryData(['website', 'email'], next);
      setPassword('');
      setSaved(true);
    },
  });
  const test = useMutation({
    mutationFn: () => sendTestEmail(testTo.trim()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['website', 'email', 'log'] }),
  });

  return (
    <NamedSection
      title={t('web.mail.title')}
      description={t('web.mail.description')}
      actions={
        mayUpdate ? (
          <div className="flex items-center gap-3">
            {saved ? (
              <span role="status" className="text-xs text-muted-foreground">
                {t('web.saved')}
              </span>
            ) : null}
            <Button
              size="sm"
              disabled={save.isPending || !value.keyConfigured || host.trim() === ''}
              onClick={() => save.mutate()}
            >
              {t('web.save')}
            </Button>
          </div>
        ) : null
      }
    >
      {value.keyConfigured ? null : (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {t('web.pay.noKey')}
        </p>
      )}
      <fieldset disabled={!mayUpdate} className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} />
          {t('web.mail.enabled')}
        </label>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <Field id={`${id}-host`} label={t('web.mail.host')}>
            <input
              id={`${id}-host`}
              value={host}
              maxLength={253}
              autoComplete="off"
              className={control}
              onChange={(event) => setHost(event.target.value)}
            />
          </Field>
          <Field id={`${id}-port`} label={t('web.mail.port')}>
            <input
              id={`${id}-port`}
              inputMode="numeric"
              value={port}
              maxLength={5}
              className={control}
              onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={secure} onCheckedChange={(next) => setSecure(next === true)} />
          {t('web.mail.secure')}
        </label>
        <Field id={`${id}-user`} label={t('web.mail.username')}>
          <input
            id={`${id}-user`}
            value={username}
            maxLength={254}
            autoComplete="off"
            className={control}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field
          id={`${id}-password`}
          label={t('web.mail.password')}
          hint={
            value.passwordFingerprint === null
              ? t('web.pay.passwordNone')
              : `${t('web.pay.passwordSet')} ${value.passwordFingerprint}`
          }
        >
          <input
            id={`${id}-password`}
            type="password"
            value={password}
            maxLength={200}
            autoComplete="new-password"
            className={control}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-from-name`} label={t('web.mail.fromName')}>
            <input
              id={`${id}-from-name`}
              value={fromName}
              maxLength={120}
              className={control}
              onChange={(event) => setFromName(event.target.value)}
            />
          </Field>
          <Field id={`${id}-from-email`} label={t('web.mail.fromEmail')}>
            <input
              id={`${id}-from-email`}
              type="email"
              value={fromEmail}
              maxLength={254}
              className={control}
              onChange={(event) => setFromEmail(event.target.value)}
            />
          </Field>
        </div>
        <Problem error={save.error} />
      </fieldset>
      {mayUpdate ? (
        <div className="mt-5 space-y-2 border-t border-border pt-4">
          <Field id={`${id}-test`} label={t('web.mail.testTo')} hint={t('web.mail.testHelp')}>
            <div className="flex gap-2">
              <input
                id={`${id}-test`}
                type="email"
                value={testTo}
                maxLength={254}
                className={control}
                onChange={(event) => setTestTo(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={test.isPending || testTo.trim() === '' || !value.configured}
                onClick={() => test.mutate()}
              >
                {t('web.mail.test')}
              </Button>
            </div>
          </Field>
          {test.data === undefined ? null : (
            <p role="status" className="text-sm">
              {test.data.sent
                ? t('web.mail.testSent')
                : `${t('web.mail.testFailed')} ${test.data.error ?? ''}`}
            </p>
          )}
          <Problem error={test.error} />
        </div>
      ) : null}
    </NamedSection>
  );
}

const STATE_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  sent: 'success',
  queued: 'warning',
  failed: 'danger',
  skipped: 'neutral',
};

function Log({ items }: { readonly items: readonly EmailLogRow[] }) {
  const t = useWebsiteT();
  return (
    <NamedSection title={t('web.mail.log')} description={t('web.mail.logHelp')}>
      {items.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
            <caption className="sr-only">{t('web.mail.log')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="font-medium">{t('web.mail.to')}</th>
                <th className="font-medium">{t('web.mail.subject')}</th>
                <th className="font-medium">{t('web.pay.status')}</th>
                <th className="font-medium">{t('web.pay.when')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((email) => (
                <tr key={email.id} className="h-row border-b border-border last:border-b-0">
                  <td className="break-all">{email.to}</td>
                  <td>{email.subject}</td>
                  <td>
                    <StatusBadge tone={STATE_TONE[email.state] ?? 'neutral'}>
                      {t(`web.mail.state.${email.state}` as WebsiteMessageKey)}
                    </StatusBadge>
                    {email.error === null ? null : (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {email.error}
                      </span>
                    )}
                  </td>
                  <td>
                    <DateTime value={email.sentAt ?? email.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </NamedSection>
  );
}
