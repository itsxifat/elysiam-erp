import { Button, ConfirmDialog, DateTime, Dialog, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { env } from '../../env.js';
import { issueKey, listKeys, revokeKey, type IssuedSiteKey, type SiteKey } from './api.js';
import { useWebsiteT } from './messages.js';
import { control, Empty, Field, Loadable, Problem, WebsitePage } from './parts.js';

/**
 * Website → Connection (M33, D-506): the keys the website's server reads the catalog with.
 *
 * A key's id is public and listed; its **secret is shown once**, in the dialog that issues
 * it, because the server stores nothing it could show again (the secret is derived). A lost
 * secret is a revoked key and a new one.
 */
export function WebsiteConnectionPage() {
  const t = useWebsiteT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['website', 'keys'], queryFn: listKeys });
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState<SiteKey | null>(null);
  const mayCreate = ability.can('create', 'Storefront');
  const mayRevoke = ability.can('update', 'Storefront');
  const endpoint = `${env.VITE_API_URL.replace(/\/+$/, '')}/storefront/v1`;

  return (
    <WebsitePage tab="/website/connection">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('web.keys.caption')}</p>
        {mayCreate ? (
          <Button
            size="sm"
            disabled={query.data?.configured === false}
            onClick={() => setIssuing(true)}
          >
            <KeyRound aria-hidden />
            {t('web.keys.issue')}
          </Button>
        ) : null}
      </div>
      <dl className="text-sm">
        <dt className="text-xs text-muted-foreground">{t('web.keys.endpoint')}</dt>
        <dd className="font-mono text-xs break-all">{endpoint}</dd>
      </dl>
      <Loadable query={query}>
        {(data) => (
          <>
            {data.configured ? null : (
              <p role="status" className="text-sm text-muted-foreground">
                {t('web.keys.notConfigured')}
              </p>
            )}
            {data.items.length === 0 ? (
              <Empty />
            ) : (
              <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
                <caption className="sr-only">{t('web.nav.connection')}</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="font-medium">{t('web.keys.label')}</th>
                    <th className="font-medium">{t('web.keys.keyId')}</th>
                    <th className="font-medium">{t('web.keys.lastUsed')}</th>
                    <th className="font-medium">{t('web.keys.status')}</th>
                    <th>
                      <span className="sr-only">{t('web.keys.revoke')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((key) => (
                    <tr key={key.id} className="h-row border-b border-border last:border-b-0">
                      <td className="font-medium">{key.label}</td>
                      <td className="font-mono text-xs break-all">{key.keyId}</td>
                      <td>
                        {key.lastUsedAt === null ? (
                          <span className="text-muted-foreground">{t('web.keys.never')}</span>
                        ) : (
                          <DateTime value={key.lastUsedAt} />
                        )}
                      </td>
                      <td>
                        <StatusBadge tone={key.revokedAt === null ? 'success' : 'neutral'}>
                          {key.revokedAt === null ? t('web.keys.active') : t('web.keys.revoked')}
                        </StatusBadge>
                      </td>
                      <td className="text-right">
                        {mayRevoke && key.revokedAt === null ? (
                          <Button size="sm" variant="ghost" onClick={() => setRevoking(key)}>
                            {t('web.keys.revoke')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Loadable>
      {issuing ? <IssueDialog onClose={() => setIssuing(false)} /> : null}
      {revoking === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setRevoking(null);
          }}
          title={t('web.keys.revokeTitle')}
          description={t('web.keys.revokeDetail')}
          confirmLabel={t('web.keys.revoke')}
          cancelLabel={t('web.cancel')}
          closeLabel={t('web.close')}
          destructive
          onConfirm={async () => {
            await revokeKey(revoking.id);
            setRevoking(null);
            await queryClient.invalidateQueries({ queryKey: ['website', 'keys'] });
          }}
        />
      )}
    </WebsitePage>
  );
}

function IssueDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useWebsiteT();
  const id = useId();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [issued, setIssued] = useState<IssuedSiteKey | null>(null);

  const issue = useMutation({
    mutationFn: () => issueKey(label.trim()),
    onSuccess: async (result) => {
      setIssued(result);
      await queryClient.invalidateQueries({ queryKey: ['website', 'keys'] });
    },
  });

  if (issued !== null) {
    return (
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title={t('web.keys.secretTitle')}
        description={t('web.keys.secretDetail')}
        closeLabel={t('web.close')}
        footer={<Button onClick={onClose}>{t('web.close')}</Button>}
      >
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">{t('web.keys.keyId')}</dt>
            <dd className="font-mono text-xs break-all">{issued.keyId}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('web.keys.secret')}</dt>
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
      title={t('web.keys.issueTitle')}
      closeLabel={t('web.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('web.cancel')}
          </Button>
          <Button disabled={label.trim() === '' || issue.isPending} onClick={() => issue.mutate()}>
            {t('web.keys.issue')}
          </Button>
        </>
      }
    >
      <Field id={`${id}-label`} label={t('web.keys.label')}>
        <input
          id={`${id}-label`}
          value={label}
          maxLength={120}
          className={control}
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>
      <Problem error={issue.error} />
    </Dialog>
  );
}
