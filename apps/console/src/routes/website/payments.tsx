import { Button, Checkbox, DateTime, Money, Select, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAbility, useOrgWide } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  getPaymentSettings,
  listPaymentSessions,
  savePaymentSettings,
  type PaymentSession,
  type PaymentSettings,
} from './api.js';
import { useWebsiteT, type WebsiteMessageKey } from './messages.js';
import { control, Empty, Field, Loadable, NamedSection, Problem, WebsitePage } from './parts.js';
import '../../i18n/website.js';

/**
 * Website → Payments (M34, D-525, D-528): the brand's SSLCommerz account and the online
 * payments the website took.
 *
 * Everyone who reads the website sees whether the gateway is set up and what was paid; only
 * an org admin (`update WebsiteCredentials`) changes the account, because the store id decides
 * whose bank the shoppers' money reaches. The store password is write-only: the screen shows a
 * fingerprint that says which one is set, never the password.
 */
export function WebsitePaymentsPage() {
  // The list of every online payment is for those who see every buyer (ledger audit W6, D-725).
  const seesPayments = useOrgWide()('read', 'Customer');
  const settings = useQuery({ queryKey: ['website', 'payments'], queryFn: getPaymentSettings });
  const sessions = useQuery({
    queryKey: ['website', 'payments', 'sessions'],
    queryFn: listPaymentSessions,
    enabled: seesPayments,
  });
  return (
    <WebsitePage tab="/website/payments" wide>
      <Loadable query={settings}>{(value) => <GatewayForm value={value} />}</Loadable>
      {seesPayments ? (
        <Loadable query={sessions}>{(value) => <Sessions items={value.items} />}</Loadable>
      ) : null}
    </WebsitePage>
  );
}

function GatewayForm({ value }: { readonly value: PaymentSettings }) {
  const t = useWebsiteT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'WebsiteCredentials');
  const [enabled, setEnabled] = useState(value.enabled);
  const [mode, setMode] = useState<'sandbox' | 'live'>(value.mode);
  const [storeId, setStoreId] = useState(value.storeId);
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      savePaymentSettings({
        enabled,
        mode,
        storeId: storeId.trim(),
        ...(password === '' ? {} : { storePassword: password }),
      }),
    onMutate: () => setSaved(false),
    onSuccess: (next) => {
      queryClient.setQueryData(['website', 'payments'], next);
      setPassword('');
      setSaved(true);
    },
  });

  return (
    <NamedSection
      title={t('web.pay.title')}
      description={t('web.pay.description')}
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
              disabled={
                save.isPending ||
                !value.keyConfigured ||
                storeId.trim() === '' ||
                (!value.hasPassword && password === '')
              }
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
      {value.verified ? null : (
        <p className="mb-4 text-xs text-muted-foreground">{t('web.pay.unverified')}</p>
      )}
      {value.sandboxAllowed || mode === 'live' ? null : (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {t('web.pay.sandboxRefused')}
        </p>
      )}
      <fieldset disabled={!mayUpdate} className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} />
          {t('web.pay.enabled')}
        </label>
        <Field id={`${id}-mode`} label={t('web.pay.mode')}>
          <Select
            id={`${id}-mode`}
            value={mode}
            onValueChange={(next) => setMode(next === 'live' ? 'live' : 'sandbox')}
            options={[
              { value: 'sandbox', label: t('web.pay.sandbox') },
              { value: 'live', label: t('web.pay.live') },
            ]}
          />
        </Field>
        <Field id={`${id}-store`} label={t('web.pay.storeId')}>
          <input
            id={`${id}-store`}
            value={storeId}
            maxLength={30}
            autoComplete="off"
            className={control}
            onChange={(event) => setStoreId(event.target.value)}
          />
        </Field>
        <Field
          id={`${id}-password`}
          label={t('web.pay.password')}
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
            maxLength={100}
            autoComplete="new-password"
            className={control}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t('web.pay.ipn')}</dt>
            <dd className="font-mono text-xs break-all">{value.ipnUrl}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('web.pay.wallet')}</dt>
            <dd>
              {value.wallet.code} · {value.wallet.name}
            </dd>
          </div>
        </dl>
        <Problem error={save.error} />
      </fieldset>
    </NamedSection>
  );
}

const SESSION_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  paid: 'success',
  refused: 'danger',
  failed: 'danger',
  ready: 'warning',
  initiating: 'warning',
  validating: 'warning',
  cancelled: 'neutral',
  expired: 'neutral',
};

function Sessions({ items }: { readonly items: readonly PaymentSession[] }) {
  const t = useWebsiteT();
  const { locale } = useLocale();
  return (
    <NamedSection title={t('web.pay.sessions')} description={t('web.pay.sessionsHelp')}>
      {items.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
            <caption className="sr-only">{t('web.pay.sessions')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="font-medium">{t('web.pay.order')}</th>
                <th className="font-medium">{t('web.pay.tran')}</th>
                <th className="text-right font-medium">{t('web.pay.amount')}</th>
                <th className="font-medium">{t('web.pay.status')}</th>
                <th className="font-medium">{t('web.pay.when')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((session) => (
                <tr key={session.id} className="h-row border-b border-border last:border-b-0">
                  <td className="font-medium">{session.orderNo ?? '—'}</td>
                  <td className="font-mono text-xs">{session.tranId}</td>
                  <td className="text-right tabular-nums">
                    <Money poisha={session.amountPoisha} locale={locale} />
                  </td>
                  <td>
                    <StatusBadge tone={SESSION_TONE[session.status] ?? 'neutral'}>
                      {t(`web.pay.state.${session.status}` as WebsiteMessageKey)}
                    </StatusBadge>
                    {session.risky ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('web.pay.risky')}
                      </span>
                    ) : null}
                    {session.failureReason === null || session.status === 'paid' ? null : (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {session.failureReason}
                      </span>
                    )}
                  </td>
                  <td>
                    <DateTime value={session.createdAt} />
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
