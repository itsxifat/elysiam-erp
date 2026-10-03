import { Button, DateTime, Dialog, Select, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { issueSiteKey, listSiteKeys, revokeSiteKey, type SiteKeyRow } from './api.js';
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
 * Website order keys (M11's intake; D-394).
 *
 * A key is the credential a landing page or the brand's website signs orders with. Its id is
 * public and listed; its **secret is shown exactly once**, in the dialog that issues it,
 * because that is the only response that carries it (the server stores a digest). A lost
 * secret is a revoked key and a new one, not a "show again" button.
 */
export function SiteKeysPage() {
  const t = useSettingsT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['settings', 'site-keys'], queryFn: listSiteKeys });
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState<SiteKeyRow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSiteKey(id),
    onSuccess: async () => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ['settings', 'site-keys'] });
    },
    onError: (error) => setProblem(messageOf(error, t('settings.errorDetail'))),
  });

  const mayRevoke = ability.can('update', 'LandingPage');

  return (
    <SettingsPage tab="/settings/site-keys">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{t('settings.siteKeys.caption')}</p>
        <Button size="sm" onClick={() => setIssuing(true)}>
          <KeyRound aria-hidden="true" />
          {t('settings.siteKeys.issue')}
        </Button>
      </div>
      <Loadable query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <table className={tableClass}>
              <caption className="sr-only">{t('settings.nav.siteKeys')}</caption>
              <thead>
                <tr className={headClass}>
                  <th className="py-1.5 font-medium">{t('settings.siteKeys.colLabel')}</th>
                  <th className="py-1.5 font-medium">{t('settings.siteKeys.colChannel')}</th>
                  <th className="py-1.5 font-medium">{t('settings.siteKeys.colKeyId')}</th>
                  <th className="py-1.5 font-medium">{t('settings.siteKeys.colLastUsed')}</th>
                  <th className="py-1.5 font-medium">{t('settings.colStatus')}</th>
                  <th className="py-1.5">
                    <span className="sr-only">{t('settings.siteKeys.revoke')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((key) => (
                  <tr key={key.id} className={rowClass}>
                    <td className="py-1.5 font-medium">{key.label}</td>
                    <td className="py-1.5">{t(`orders.channel.${key.channel}`)}</td>
                    <td className="py-1.5 font-mono text-xs break-all">{key.keyId}</td>
                    <td className="py-1.5">
                      {key.lastUsedAt === null ? (
                        <span className="text-muted-foreground">
                          {t('settings.siteKeys.never')}
                        </span>
                      ) : (
                        <DateTime value={key.lastUsedAt} />
                      )}
                    </td>
                    <td className="py-1.5">
                      <StatusBadge tone={key.revokedAt === null ? 'success' : 'neutral'}>
                        {key.revokedAt === null
                          ? t('settings.active')
                          : t('settings.siteKeys.revoked')}
                      </StatusBadge>
                    </td>
                    <td className="py-1.5 text-right">
                      {mayRevoke && key.revokedAt === null ? (
                        <Button size="sm" variant="ghost" onClick={() => setRevoking(key)}>
                          {t('settings.siteKeys.revoke')}
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
      {issuing ? <IssueDialog onClose={() => setIssuing(false)} /> : null}
      {revoking === null ? null : (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setRevoking(null);
          }}
          title={t('settings.siteKeys.revokeTitle')}
          description={t('settings.siteKeys.revokeDetail')}
          closeLabel={t('settings.close')}
          footer={
            <>
              <Button variant="outline" onClick={() => setRevoking(null)}>
                {t('settings.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(revoking.id)}
              >
                {t('settings.siteKeys.revoke')}
              </Button>
            </>
          }
        >
          <p className="text-sm">
            {revoking.label} · <span className="font-mono text-xs">{revoking.keyId}</span>
          </p>
          {problem === null ? null : (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {problem}
            </p>
          )}
        </Dialog>
      )}
    </SettingsPage>
  );
}

function IssueDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useSettingsT();
  const id = useId();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [channel, setChannel] = useState<'landing_page' | 'website'>('landing_page');
  const [issued, setIssued] = useState<{ keyId: string; secret: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const issue = useMutation({
    mutationFn: () => issueSiteKey({ label: label.trim(), channel }),
    onSuccess: async (result) => {
      setIssued({ keyId: result.keyId, secret: result.secret });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'site-keys'] });
    },
    onError: (error) => setProblem(messageOf(error, t('settings.errorDetail'))),
  });

  if (issued !== null) {
    return (
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title={t('settings.siteKeys.secretTitle')}
        description={t('settings.siteKeys.secretDetail')}
        closeLabel={t('settings.close')}
        footer={<Button onClick={onClose}>{t('settings.close')}</Button>}
      >
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">{t('settings.siteKeys.colKeyId')}</dt>
            <dd className="font-mono text-xs break-all">{issued.keyId}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('settings.siteKeys.secret')}</dt>
            <dd>
              <code className="block rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs break-all select-all">
                {issued.secret}
              </code>
            </dd>
          </div>
        </dl>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('settings.siteKeys.issueTitle')}
      closeLabel={t('settings.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
          <Button
            disabled={issue.isPending}
            onClick={() => {
              if (label.trim() === '') {
                setProblem(t('settings.siteKeys.invalid'));
                return;
              }
              setProblem(null);
              issue.mutate();
            }}
          >
            {t('settings.siteKeys.issue')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-label`} label={t('settings.siteKeys.colLabel')}>
          <input
            id={`${id}-label`}
            value={label}
            maxLength={120}
            className={control}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Field id={`${id}-channel`} label={t('settings.siteKeys.colChannel')}>
          <Select
            id={`${id}-channel`}
            value={channel}
            onValueChange={(value) => setChannel(value === 'website' ? 'website' : 'landing_page')}
            options={[
              { value: 'landing_page', label: t('orders.channel.landing_page') },
              { value: 'website', label: t('orders.channel.website') },
            ]}
          />
        </Field>
      </div>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
